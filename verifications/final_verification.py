import asyncio
from playwright.async_api import async_playwright
import os

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        # Get the absolute path to the index.html file
        html_file_path = os.path.abspath('index.html')

        await page.goto(f'file://{html_file_path}')

        # --- ADDED LOGIC TO LOAD A FILE ---
        # 1. Fill the fetch input
        await page.fill('#fetch-id', '4HHB')

        # 2. Click the fetch button
        await page.click('#fetch-btn')
        # --- END OF ADDED LOGIC ---

        # Wait for the viewer to be visible after fetching
        await page.wait_for_selector('#viewer-container', state='visible', timeout=20000) # Increased timeout

        # Take a screenshot
        screenshot_path = os.path.abspath('verification_screenshot.png')
        await page.screenshot(path=screenshot_path)

        print(f"Screenshot saved to {screenshot_path}")

        await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
