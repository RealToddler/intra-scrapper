import puppeteer from 'puppeteer';
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";

const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf-8'));
const BASE_URL = "https://intra.forge.epita.fr";
const CONCURRENCY = config.concurrency || 4;
const OUTPUT_DIR = resolve(config.outputDir || './output');

await mkdir(OUTPUT_DIR, { recursive: true });

const startTime = Date.now();
const stats = { projects: 0, activities: 0, files: 0, extensions: {} };
let subDone = 0, subTotal = 0;

function progress() {
    process.stdout.write(`\r[${subDone}/${subTotal}] ${stats.files} files downloaded`);
}

function trackFile(filename) {
    stats.files++;
    const ext = extname(filename).toLowerCase() || '(no ext)';
    stats.extensions[ext] = (stats.extensions[ext] || 0) + 1;
}

const normalize = (text) =>
    text.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

const browser = await puppeteer.launch({
    headless: config.headless ?? false,
    defaultViewport: { width: 1280, height: 800 }
});

const loginPage = await browser.newPage();
await loginPage.goto(BASE_URL);
await loginPage.type('#id_username', config.login);
await loginPage.type('#id_password', config.password);
await loginPage.click('button[type="submit"]');
await loginPage.waitForNavigation({ waitUntil: 'networkidle2' });

const cookies = await loginPage.cookies();

async function newAuthPage() {
    const p = await browser.newPage();
    await p.setCookie(...cookies);
    return p;
}

async function downloadFile(pg, url, destPath) {
    try {
        const response = await pg.evaluate(async (fileUrl) => {
            const res = await fetch(fileUrl);
            if (!res.ok) return null;
            const blob = await res.blob();
            const reader = new FileReader();
            return new Promise(resolve => {
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });
        }, url);
        if (!response) return;
        await writeFile(destPath, Buffer.from(response.split(',')[1], 'base64'));
        trackFile(destPath);
        progress();
    } catch {}
}

async function downloadPageFiles(pg, dir) {
    const files = await pg.evaluate(() => {
        const list = document.querySelector(".stack > div:first-child .list");
        if (!list) return [];
        return Array.from(list.querySelectorAll("a.list__item"))
            .map(a => ({
                name: a.querySelector(".list__item__name")?.textContent?.trim() || "",
                link: a.href
            }))
            .filter(f => f.name && f.link && !f.name.toLowerCase().includes("dyslexic"));
    });
    for (const file of files)
        await downloadFile(pg, file.link, join(dir, file.name));
}

const visited = new Set();

async function processPage(pg, url, dir, depth = 0) {
    if (visited.has(url)) return;
    visited.add(url);

    try {
        await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await pg.waitForSelector('.project, .list, #graph, .stack', { timeout: 10000 }).catch(() => {});
    } catch { return; }

    let hasGraph = await pg.$('#graph');
    if (hasGraph) {
        try { await pg.waitForSelector('#graph .nodes .node a', { timeout: 15000 }); }
        catch { hasGraph = null; }
    }

    if (!hasGraph) {
        const exercises = await pg.$$eval(".list a.list__item[data-name]", items =>
            items.map(a => ({ name: a.getAttribute("data-name")?.trim() || "", link: a.href }))
                .filter(e => e.name && e.link)
        );
        if (exercises.length > 0) {
            for (const ex of exercises) {
                try {
                    const exDir = join(dir, normalize(ex.name));
                    await mkdir(exDir, { recursive: true });
                    stats.activities++;
                    await pg.goto(ex.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await pg.waitForSelector('.list, .stack', { timeout: 10000 }).catch(() => {});
                    await downloadPageFiles(pg, exDir);
                } catch {}
            }
        } else {
            await downloadPageFiles(pg, dir);
        }
        return;
    }

    const nodes = await pg.$$eval("#graph .nodes .node a", anchors =>
        anchors.map(a => ({ label: a.querySelector(".nodeLabel")?.textContent?.trim() || "", link: a.getAttribute("href") || "" }))
            .filter(n => n.label && n.link && n.link.startsWith("/"))
    );

    for (const node of nodes) {
        try {
            const nodeDir = join(dir, normalize(node.label));
            await mkdir(nodeDir, { recursive: true });
            await processPage(pg, BASE_URL + node.link, nodeDir, depth + 1);
        } catch {}
    }
}

async function runPool(tasks, concurrency) {
    let index = 0;
    async function worker() {
        while (index < tasks.length) await tasks[index++]();
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
}

const projects = await loginPage.$$eval("a.project", cards =>
    cards.map(c => ({ title: c.querySelector(".project__title")?.textContent?.trim() || "", link: c.href }))
        .filter(p => p.title && p.link)
);

const allSubProjects = [];
for (const project of projects) {
    const projectName = normalize(project.title);
    const projectDir = join(OUTPUT_DIR, projectName);
    await mkdir(projectDir, { recursive: true });
    stats.projects++;
    console.log(`[tenant] ${projectName}`);

    await loginPage.goto(project.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await loginPage.waitForSelector('a.project', { timeout: 10000 }).catch(() => {});

    const subs = await loginPage.$$eval("a.project", cards =>
        cards.map(c => ({ title: c.querySelector(".project__title")?.textContent?.trim() || "", link: c.href }))
            .filter(p => p.title && p.link)
    );

    for (const sub of subs) {
        const subDir = join(projectDir, normalize(sub.title));
        await mkdir(subDir, { recursive: true });
        allSubProjects.push({ link: sub.link, dir: subDir });
    }
}

await loginPage.close();

subTotal = allSubProjects.length;
console.log(`\nProcessing ${subTotal} activities with ${CONCURRENCY} workers\n`);

const tasks = allSubProjects.map(sub => async () => {
    const pg = await newAuthPage();
    try { await processPage(pg, sub.link, sub.dir, 2); }
    catch {}
    finally { subDone++; progress(); await pg.close(); }
});

await runPool(tasks, CONCURRENCY);

const elapsed = Date.now() - startTime;
const seconds = Math.floor(elapsed / 1000) % 60;
const minutes = Math.floor(elapsed / 60000);
const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

const extLines = Object.entries(stats.extensions)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `  ${ext}: ${count}`);

const report = [
    '=== Scraping Report ===',
    `Date: ${new Date().toISOString()}`,
    `Duration: ${timeStr}`,
    '',
    `Tenants: ${stats.projects}`,
    `Activities: ${stats.activities}`,
    `Files: ${stats.files}`,
    '',
    'By extension:',
    ...extLines,
].join('\n');

await writeFile(join(OUTPUT_DIR, 'report.txt'), report, 'utf-8');
console.log('\n\n' + report + '\n');
await browser.close();
