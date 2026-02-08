# intra-scrapper

Scrapes EPITA intra tenants and downloads related files.

## Requirements

- Node.js 18+ (ES modules)
- npm

## Install

```bash
npm install
```

## Configure

Edit `config.json`:

```json
{
  "login": "your.login",
  "password": "your.password",
  "outputDir": "./output",
  "concurrency": 4,
  "headless": false
}
```

## Run

```bash
npm start
```

## Output

- Files are saved under `outputDir`.
- A report is generated at `outputDir/report.txt` and also printed at the end.

## Notes

- The script skips files with "dyslexic" in the name.
- If the intra pages are slow, reduce `concurrency`.
