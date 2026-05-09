import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import puppeteer from "puppeteer";
const server = new McpServer({
    name: "hdc_moph_explorer",
    version: "1.0.0",
});
// Tool สำหรับดึงข้อมูลจากตารางในหน้า HDC
server.tool("fetch_hdc_data", "ดึงข้อมูลสถิติจากหน้าเว็บ HDC MOPH ตาม URL ที่ระบุ", {
    url: z.string().describe("URL ของหน้ารายงานใน hdc.moph.go.th"),
}, async ({ url }) => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        // ตั้งค่า User Agent เพื่อเลี่ยงการบล็อก
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        // รอให้ตารางหลักโหลด (Selector นี้อาจต้องปรับตามโครงสร้างจริงของหน้า HDC นั้นๆ)
        await page.waitForSelector('table', { timeout: 10000 });
        const tableData = await page.evaluate(() => {
            const table = document.querySelector('table');
            if (!table)
                return "ไม่พบตารางข้อมูลในหน้านี้";
            const rows = Array.from(table.querySelectorAll('tr'));
            return rows.map(row => {
                // ใส่ (cell as HTMLElement) เพื่อให้เข้าถึง innerText ได้
                const cells = Array.from(row.querySelectorAll('th, td'));
                return cells.map(cell => cell.innerText.trim()).join(" | ");
            }).join("\n");
        });
        await browser.close();
        return {
            content: [{ type: "text", text: `ข้อมูลจากเว็บ HDC:\n\n${tableData}` }],
        };
    }
    catch (error) {
        if (browser)
            await browser.close();
        return {
            content: [{ type: "text", text: `เกิดข้อผิดพลาด: ${error.message}` }],
            isError: true,
        };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("HDC MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map