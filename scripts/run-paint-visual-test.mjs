import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const root = process.cwd();
const port = 4174;
const url = `http://127.0.0.1:${port}/?paintTest=1`;
const outputDirectory = path.join(root, "test-results");
const screenshotPath = path.join(outputDirectory, "paint-whole-body.png");
const circleScreenshotPath = path.join(outputDirectory, "paint-circle.png");
const shoulderScreenshotPath = path.join(outputDirectory, "paint-shoulder.png");
const lineScreenshotPath = path.join(outputDirectory, "paint-smooth-line.png");
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
];

const executablePath = chromeCandidates.find((candidate) => {
  try {
    return process.getBuiltinModule("node:fs").existsSync(candidate);
  } catch {
    return false;
  }
});
if (!executablePath) throw new Error("Paint visual test requires Chrome, Edge, or Chromium");

const viteCli = path.join(root, "client", "node_modules", "vite", "bin", "vite.js");
const server = spawn(process.execPath, [viteCli, "--host", "127.0.0.1", "--port", String(port)], {
  cwd: path.join(root, "client"),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += String(chunk); });
server.stderr.on("data", (chunk) => { serverOutput += String(chunk); });

let browser;
try {
  await waitForServer(url, 20_000);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  });
  const page = await browser.newPage({ viewport: { width: 720, height: 720 }, deviceScaleFactor: 1 });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  try {
    await page.locator('body[data-paint-test-stage="circle"]').waitFor({ timeout: 30_000 });
  } catch (error) {
    const pageState = await page.locator("body").evaluate((body) => ({ text: body.textContent, dataset: { ...body.dataset } }));
    throw new Error(`${error.message}\nPage state: ${JSON.stringify(pageState)}\nBrowser errors: ${browserErrors.join(" | ")}`);
  }
  await mkdir(outputDirectory, { recursive: true });
  await page.screenshot({ path: circleScreenshotPath });
  await page.evaluate(() => { window.__continuePaintTest = true; });
  await page.locator('body[data-paint-test-stage="shoulder"]').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: shoulderScreenshotPath });
  await page.evaluate(() => { window.__continuePaintTest = true; });
  await page.locator('body[data-paint-test-stage="line"]').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: lineScreenshotPath });
  await page.evaluate(() => { window.__continuePaintTest = true; });
  await page.locator("body[data-paint-test]").waitFor({ timeout: 120_000 });
  const result = await page.evaluate(() => window.__paintTestResult);
  await page.screenshot({ path: screenshotPath });
  if (browserErrors.length) throw new Error(`Browser errors:\n${browserErrors.join("\n")}`);
  if (!result?.passed) throw new Error(`Paint coverage failed: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ ...result, circleScreenshotPath, shoulderScreenshotPath, lineScreenshotPath, screenshotPath }, null, 2));
} finally {
  await browser?.close();
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (server.exitCode && server.exitCode !== 0) process.stderr.write(serverOutput);
}

async function waitForServer(target, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(target);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${target}\n${serverOutput}`);
}
