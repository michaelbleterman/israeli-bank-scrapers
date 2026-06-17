/**
 * Bank Hapoalim — 2FA (SMS OTP) + device-trust persistence example.
 *
 * Based on the 2FA OTP + device-trust work in PR #1084 (by @avivghilai), plus a
 * fix that restores the device-trust localStorage on the origin it was captured
 * from (otherwise Hapoalim re-challenges 2FA on every "trusted" login).
 *
 * Demonstrates the two halves of the Hapoalim 2FA flow:
 *   1. First login: the bank challenges with an SMS OTP. The `otpCodeRetriever`
 *      callback supplies the code (here, from a terminal prompt). On success the
 *      scraper returns `deviceTrustData` (cookies + localStorage).
 *   2. Trusted login: pass that saved `deviceTrustData` back in and the bank
 *      recognizes the device and skips the OTP challenge entirely.
 *
 * The example persists `deviceTrustData` to a file between runs so you can prove
 * the second run is not challenged.
 *
 * Run (no extra dependency needed — `tsx` is fetched on demand):
 *   HAPOALIM_USER_CODE=... HAPOALIM_PASSWORD=... npx tsx examples/hapoalim-2fa-device-trust.ts
 *
 *   # force the OTP path even if trust data exists:
 *   ... npx tsx examples/hapoalim-2fa-device-trust.ts first
 *   # require saved trust data and assert OTP is skipped:
 *   ... npx tsx examples/hapoalim-2fa-device-trust.ts trusted
 *
 * Env:
 *   HAPOALIM_USER_CODE   (required) Hapoalim user identification code
 *   HAPOALIM_PASSWORD    (required) Hapoalim password
 *   HAPOALIM_TRUST_FILE  (optional) where to read/write deviceTrustData
 *                                   (default: <os tmpdir>/hapoalim-device-trust.json)
 *   SHOW_BROWSER=1       (optional) run headful so you can watch the OTP modal
 *
 * Security: credentials are read from the environment only and are never logged.
 * `deviceTrustData` is a 2FA-bypass bearer token — keep the trust file private
 * (it lives outside the repo by default) and never commit it. This example prints
 * only counts/masked values, never the secrets themselves.
 *
 * External consumers: replace the `../src` import below with the package name,
 * e.g. `import { createScraper, CompanyTypes, ... } from 'israeli-bank-scrapers';`
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { createScraper, CompanyTypes, type DeviceTrustData, type ScraperScrapingResult } from '../src';

const TRUST_FILE = process.env.HAPOALIM_TRUST_FILE || path.join(os.tmpdir(), 'hapoalim-device-trust.json');

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/** Mask an account number so only the last 4 chars are shown. */
function maskAccount(value?: string): string {
  if (!value) return String(value);
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
}

function loadTrustData(): DeviceTrustData | undefined {
  if (!fs.existsSync(TRUST_FILE)) return undefined;
  return JSON.parse(fs.readFileSync(TRUST_FILE, 'utf8')) as DeviceTrustData;
}

function saveTrustData(data: DeviceTrustData): void {
  fs.writeFileSync(TRUST_FILE, JSON.stringify(data), { mode: 0o600 });
}

async function run(label: string, deviceTrustData?: DeviceTrustData): Promise<{ success: boolean; otpAsked: boolean }> {
  let otpAsked = false;

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - 3);

  const scraper = createScraper({
    companyId: CompanyTypes.hapoalim,
    startDate,
    showBrowser: process.env.SHOW_BROWSER === '1',
    ...(deviceTrustData ? { deviceTrustData } : {}),
  });

  console.log(`\n=== ${label} (deviceTrust ${deviceTrustData ? 'provided' : 'none'}) ===`);

  const result: ScraperScrapingResult = await scraper.scrape({
    userCode: process.env.HAPOALIM_USER_CODE!,
    password: process.env.HAPOALIM_PASSWORD!,
    otpCodeRetriever: async options => {
      otpAsked = true;
      const attempt = options?.attempt ?? 1;
      return prompt(`[${label}] Hapoalim sent an SMS (attempt ${attempt}). Enter the code: `);
    },
  });

  console.log(`success=${result.success} errorType=${result.errorType ?? '-'} otpAsked=${otpAsked}`);

  if (result.success) {
    for (const account of result.accounts ?? []) {
      const dates = (account.txns ?? [])
        .map(t => t.date)
        .filter(Boolean)
        .sort();
      const first = dates[0]?.slice(0, 10) ?? '-';
      const last = dates.length ? dates[dates.length - 1].slice(0, 10) : '-';
      console.log(
        `  account ${maskAccount(account.accountNumber)} balance=${account.balance ?? 'n/a'} ` +
          `txns=${account.txns?.length ?? 0} range=${first}..${last}`,
      );
    }
    if (result.deviceTrustData) {
      saveTrustData(result.deviceTrustData);
      const { cookies, localStorage } = result.deviceTrustData;
      // Print only counts — never the cookie/localStorage values (they are secrets).
      console.log(
        `  deviceTrustData: ${cookies?.length ?? 0} cookies, ` +
          `${Object.keys(localStorage ?? {}).length} localStorage keys -> saved to ${TRUST_FILE}`,
      );
    }
  } else {
    console.log(`  errorMessage=${result.errorMessage ?? '-'}`);
  }

  return { success: result.success, otpAsked };
}

async function main(): Promise<void> {
  if (!process.env.HAPOALIM_USER_CODE || !process.env.HAPOALIM_PASSWORD) {
    console.error('Set HAPOALIM_USER_CODE and HAPOALIM_PASSWORD in the environment first.');
    process.exit(2);
  }

  const mode = process.argv[2] ?? 'auto'; // 'first' | 'trusted' | 'auto'

  if (mode === 'trusted') {
    const trust = loadTrustData();
    if (!trust) {
      console.error(`No trust data at ${TRUST_FILE}. Run the "first" login once before "trusted".`);
      process.exit(2);
    }
    const { otpAsked } = await run('Trusted device (expect NO OTP)', trust);
    console.log(otpAsked ? '\nOTP was requested despite device trust — FAIL.' : '\nDevice trust skipped 2FA — PASS.');
    return;
  }

  // 'first' forces the OTP path; 'auto' uses saved trust if present.
  const trust = mode === 'first' ? undefined : loadTrustData();
  await run(mode === 'first' ? 'First login (expect OTP prompt)' : 'Login (auto)', trust);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
