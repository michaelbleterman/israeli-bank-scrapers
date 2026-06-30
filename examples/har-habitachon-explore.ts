/**
 * הר הביטוח (harb.cma.gov.il) — exploratory traffic capture, NOT a scraper.
 *
 * Purpose: opens a real, visible browser pointed at the portal and lets you log in
 * manually (ID + government eGov OTP flow). While you interact with the page, this
 * script records every XHR/fetch request+response so we can see the real API shape
 * (endpoints, auth tokens, JSON payloads) before writing the actual scraper.
 *
 * This is a one-off research tool — it is NOT wired into src/, CompanyTypes, or the
 * scraper factory. Nothing here is meant to be reused as-is.
 *
 * Run:
 *   npx tsx examples/har-habitachon-explore.ts
 *
 * Then in the opened browser window:
 *   1. Navigate/log in manually (ID number + SMS OTP) as you normally would.
 *   2. Browse to wherever your policies/pension data is shown.
 *   3. Come back to the terminal and press ENTER to stop capturing and dump results.
 *
 * Output:
 *   Writes a JSON capture file (request/response pairs for XHR & fetch calls only,
 *   static assets filtered out) to the path printed at the end.
 *
 * Security: this script does NOT collect or store your ID number or OTP code anywhere
 * itself (you type them directly into the page). It DOES capture whatever the site's
 * own network traffic contains, which may include session tokens/cookies in headers —
 * treat the output file as sensitive, do not commit it, and delete it once analysis
 * is done.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import puppeteer, { type HTTPRequest, type HTTPResponse } from 'puppeteer';

const START_URL = 'https://harb.cma.gov.il/';
const OUTPUT_FILE = path.join(os.tmpdir(), `har-habitachon-capture-${Date.now()}.json`);

// Skip obvious static/noise requests so the capture stays readable.
const SKIP_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media', 'other']);
const SKIP_URL_PATTERNS = [/\.(png|jpg|jpeg|svg|gif|woff2?|ttf|css|ico)(\?|$)/i, /google-analytics|gtm\.js|hotjar/i];

interface CapturedExchange {
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyTruncated?: boolean;
}

function shouldCapture(req: HTTPRequest): boolean {
  if (SKIP_RESOURCE_TYPES.has(req.resourceType())) return false;
  if (SKIP_URL_PATTERNS.some(re => re.test(req.url()))) return false;
  return true;
}

/** Redact obviously sensitive-looking header values while keeping the key for shape analysis. */
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'cookie' || lower === 'authorization' || lower.includes('token') || lower.includes('session')) {
      redacted[key] = value ? `<redacted len=${value.length}>` : '';
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

async function main(): Promise<void> {
  console.log('Launching visible browser for manual exploration of הר הביטוח...');
  console.log(`Starting URL: ${START_URL}`);

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--window-size=1280,900'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const exchanges: CapturedExchange[] = [];
  const pendingByUrl = new Map<string, CapturedExchange>();

  page.on('request', req => {
    if (!shouldCapture(req)) return;
    const entry: CapturedExchange = {
      timestamp: new Date().toISOString(),
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      requestHeaders: redactHeaders(req.headers()),
      requestBody: req.postData(),
    };
    exchanges.push(entry);
    pendingByUrl.set(req.url() + '#' + req.method(), entry);
  });

  page.on('response', (res: HTTPResponse) => {
    const req = res.request();
    if (!shouldCapture(req)) return;
    const key = req.url() + '#' + req.method();
    const entry = pendingByUrl.get(key);
    if (!entry) return;

    entry.status = res.status();
    entry.responseHeaders = redactHeaders(res.headers());

    res
      .text()
      .then(text => {
        const MAX = 20_000;
        if (text.length > MAX) {
          entry.responseBody = text.slice(0, MAX);
          entry.responseBodyTruncated = true;
        } else {
          entry.responseBody = text;
        }
      })
      .catch(() => {
        // Binary or unreadable body (e.g. redirected navigation) — ignore.
      });
  });

  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  console.log('\nBrowser is open. Please:');
  console.log('  1. Log in manually (ID number + SMS OTP).');
  console.log('  2. Navigate to your policies / pension / insurance data.');
  console.log('  3. Come back here and press ENTER when done.\n');

  await prompt('Press ENTER to stop capturing and save the dump...');

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(exchanges, null, 2), { mode: 0o600 });
  console.log(`\nCaptured ${exchanges.length} requests.`);
  console.log(`Saved to: ${OUTPUT_FILE}`);
  console.log('\nReview this file to identify: login endpoint(s), auth token/header shape,');
  console.log('and the API endpoint(s) returning policy/pension data, then delete the file.');

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
