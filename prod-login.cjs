const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://paperclip.atahdak.com/', { waitUntil: 'networkidle' });

  await page.locator('input[type="email"]').fill('thamere@gmail.com', { timeout: 10000 });
  await page.locator('input[type="password"]').fill('Thamer@New123', { timeout: 10000 });

  const submit = page.locator('button[type="submit"]:has-text("Sign In")');
  await submit.click();

  // Wait for navigation away from auth page
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 30000 });

  const cookies = await context.cookies();
  fs.writeFileSync('C:/Users/thame/AppData/Local/Temp/prod-cookies.json', JSON.stringify(cookies, null, 2));
  console.log('logged in; cookies saved');
  console.log('current url:', page.url());

  await browser.close();
})();
