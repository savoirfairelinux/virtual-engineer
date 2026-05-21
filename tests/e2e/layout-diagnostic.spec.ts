/// <reference lib="dom" />
import { test } from "@playwright/test";

test("diagnose detail panel layout issue", async ({ page }) => {
  // Navigate to dashboard
  await page.goto("/admin");
  
  // Wait for the app to load
  await page.waitForSelector(".app", { timeout: 10000 });
  
  // Check if tasks are loaded
  const taskRows = await page.locator(".task-row").count();
  console.log(`Found ${taskRows} task rows`);
  
  if (taskRows > 0) {
    // Click first task to view details
    await page.locator(".task-row").first().click();
    
    // Wait for detail panel to render
    await page.waitForSelector(".detail-head", { timeout: 5000 });
    
    // Get detail head element
    const detailHead = page.locator(".detail-head");
    
    // Check computed styles
    const detailHeadBox = await detailHead.boundingBox();
    console.log("Detail head bounding box:", detailHeadBox);
    
    const detailHeadStyles = await detailHead.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        display: computed.display,
        position: computed.position,
        flexDirection: computed.flexDirection,
        alignItems: computed.alignItems,
        justifyContent: computed.justifyContent,
        width: computed.width,
        paddingTop: computed.paddingTop,
        paddingBottom: computed.paddingBottom,
        paddingLeft: computed.paddingLeft,
        paddingRight: computed.paddingRight,
      };
    });
    console.log("Detail head computed styles:", detailHeadStyles);
    
    // Get description element
    const description = page.locator(".detail-description");
    const descriptionBox = await description.boundingBox();
    console.log("Description bounding box:", descriptionBox);
    
    const descriptionStyles = await description.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        marginTop: computed.marginTop,
        marginLeft: computed.marginLeft,
        marginRight: computed.marginRight,
        paddingLeft: computed.paddingLeft,
        width: computed.width,
        maxWidth: computed.maxWidth,
        lineHeight: computed.lineHeight,
      };
    });
    console.log("Description computed styles:", descriptionStyles);
    
    // Check if badge exists and its position
    const badge = page.locator(".detail-head .badge");
    const badgeExists = await badge.count();
    console.log("Badge exists:", badgeExists > 0);
    
    if (badgeExists > 0) {
      const badgeStyles = await badge.evaluate((el) => {
        const computed = window.getComputedStyle(el);
        return {
          position: computed.position,
          top: computed.top,
          right: computed.right,
          display: computed.display,
        };
      });
      console.log("Badge computed styles:", badgeStyles);
      
      const badgeBox = await badge.boundingBox();
      console.log("Badge bounding box:", badgeBox);
    }
    
    // Check structure
    const hasDetailMain = await page.locator(".detail-main").count();
    console.log("Has .detail-main wrapper:", hasDetailMain > 0);
    
    const hasDetailCopy = await page.locator(".detail-copy").count();
    console.log("Has .detail-copy wrapper:", hasDetailCopy > 0);
    
    // Print HTML structure for detail-head
    const detailHeadHtml = await page.locator(".detail-head").innerHTML();
    console.log("Detail head HTML:");
    console.log(detailHeadHtml.substring(0, 500));
    
    // Take a screenshot
    await page.screenshot({ path: "detail-panel-layout.png" });
    console.log("Screenshot saved: detail-panel-layout.png");
  } else {
    console.log("No tasks found. Check if tasks are being loaded.");
  }
});
