import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import puppeteer, { type Browser, type Page } from "puppeteer";

const HDC_BASE_URL = "https://hdc.moph.go.th/center";

const server = new McpServer({
  name: "hdc_moph_explorer",
  version: "2.0.0",
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
}

async function setupPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 800 });
  return page;
}

/** แยก report_code จาก URL หรือใช้ค่าตรงๆ */
function extractReportCode(input: string): string {
  // รองรับทั้ง URL เต็ม และ code ตรงๆ
  const match = input.match(/([a-f0-9]{32})/i);
  return match?.[1] ?? input.trim();
}

/** แปลง jsonc + data → text table */
interface JsoncCol { type: string; position: string; column_name: string }
interface DataRow  { [key: string]: string | number }
interface ApiRows  { jsonc: JsoncCol[]; data: DataRow[] }
interface DataApiResponse { ok: boolean; rows: ApiRows[]; message?: string; code: number }
interface InfoApiResponse { ok: boolean; rows: ReportInfo; code: number }
interface ReportInfo {
  report_name: string;
  category_main_name?: string;
  category_sub_name?: string;
  byear_list?: number[];
  table_display?: Array<{ value: string; name: string }>;
  table_freeze?: string[];
  source_table?: string;
  seletype?: string;
}

function formatTable(rows: ApiRows[]): string {
  if (!rows || rows.length === 0) return "ไม่พบข้อมูล";
  const block = rows[0];
  if (!block) return "ไม่พบข้อมูล";
  const { jsonc, data } = block;
  if (!data || data.length === 0) return "ไม่พบข้อมูล (data เป็น empty)";

  // สร้าง column headers จาก jsonc
  const cols = jsonc.map((c) => c.column_name);

  // หาความกว้างสูงสุดของแต่ละคอลัมน์
  const widths = cols.map((col) => {
    const vals = data.map((r) => String(r[col] ?? ""));
    return Math.max(col.length, ...vals.map((v) => v.length));
  });

  const pad = (s: string, w: number) => s.padEnd(w);
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  const header = cols.map((c, i) => pad(c, widths[i] ?? 0)).join(" | ");
  const dataLines = data.map((row) =>
    cols.map((c, i) => pad(String(row[c] ?? ""), widths[i] ?? 0)).join(" | ")
  );

  return [header, separator, ...dataLines].join("\n");
}

// ── Tool 1: hdc_get ───────────────────────────────────────────────────────────

server.tool(
  "hdc_get",
  "ดึงข้อมูลรายงานจาก HDC MOPH พร้อมตัวกรอง เขตสุขภาพ จังหวัด ปีงบประมาณ โดยใช้ request interception เพื่อส่ง filter params ที่ถูกต้อง",
  {
    report_code: z
      .string()
      .describe("report_code (32 ตัว hex) หรือ URL รายงาน เช่น https://hdc.moph.go.th/center/public/standard-report-detail/<code>"),
    year: z
      .number()
      .optional()
      .default(2569)
      .describe("ปีงบประมาณ (พ.ศ.) เช่น 2569, 2568 (default: 2569)"),
    zone: z
      .string()
      .optional()
      .default("ALL")
      .describe("เขตสุขภาพ: ALL=ทุกเขต หรือ 1-13 เช่น '12'=เขตสุขภาพที่ 12"),
    province_code: z
      .string()
      .optional()
      .default("ALL")
      .describe("รหัสจังหวัด 2 หลัก: ALL หรือ '90'=สงขลา, '80'=นครศรีฯ เป็นต้น"),
    table_display: z
      .enum(["zone", "province", "district"])
      .optional()
      .default("zone")
      .describe("จัดกลุ่มข้อมูลตาม: zone=เขตสุขภาพ, province=จังหวัด, district=อำเภอ"),
    month: z
      .string()
      .optional()
      .default("ALL")
      .describe("เดือน: ALL หรือ 1-12"),
  },
  async ({ report_code, year = 2569, zone = "ALL", province_code = "ALL", table_display = "zone", month = "ALL" }) => {
    let browser: Browser | undefined;
    try {
      const code = extractReportCode(report_code);
      if (!code || code.length < 10) {
        return {
          content: [{ type: "text", text: `report_code ไม่ถูกต้อง: "${report_code}"\nต้องเป็น 32 ตัวอักษร hex หรือ URL ที่มี code อยู่` }],
          isError: true,
        };
      }

      const pageUrl = `${HDC_BASE_URL}/public/standard-report-detail/${code}`;
      const infoApiUrl = `https://api-center-hdc.moph.go.th/v1/report-public/info?reportCode=${code}&subCatalogId=`;
      const dataApiPattern = `/reports/province/data/${code}`;

      browser = await launchBrowser();
      const page = await setupPage(browser);

      // ── Step 1: Request Interception — แก้ไข params ก่อน browser ส่ง ──
      await page.setRequestInterception(true);
      let interceptedUrl = "";

      page.on("request", (req) => {
        const url = req.url();
        if (url.includes(dataApiPattern)) {
          const u = new URL(url);
          u.searchParams.set("table_display", table_display);
          u.searchParams.set("year",           String(year));
          u.searchParams.set("month",          month);
          u.searchParams.set("zone",           zone);
          u.searchParams.set("province_code",  province_code);
          interceptedUrl = u.toString();
          void req.continue({ url: interceptedUrl });
        } else {
          void req.continue();
        }
      });

      // ── Step 2: ดัก responses ──
      let capturedData: DataApiResponse | null = null;
      let capturedInfo: InfoApiResponse | null = null;

      page.on("response", (res) => {
        const url = res.url();
        if (url.includes(dataApiPattern)) {
          void res.json().then((j: unknown) => { capturedData = j as DataApiResponse; }).catch(() => undefined);
        }
        if (url.includes("report-public/info")) {
          void res.json().then((j: unknown) => { capturedInfo = j as InfoApiResponse; }).catch(() => undefined);
        }
      });

      // ── Step 3: โหลดหน้า — Angular จะเรียก API อัตโนมัติ ──
      await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 60000 });
      // รอให้ response ถูกประมวลผล
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      // ── Step 4: ถ้ายังไม่ได้ info ให้ fetch แยก ──
      if (!capturedInfo) {
        capturedInfo = await page.evaluate(async (url: string) => {
          return fetch(url, { headers: { Accept: "application/json" } })
            .then((r) => r.json() as Promise<InfoApiResponse>)
            .catch(() => null as InfoApiResponse | null);
        }, infoApiUrl);
      }

      await browser.close();

      // ── Error handling ──
      // TypeScript ไม่ track assignment ใน async callback ได้ ต้อง cast ผ่าน wrapper
      const data = capturedData as DataApiResponse | null;

      if (!data) {
        return {
          content: [{ type: "text", text: `ไม่ได้รับข้อมูลจาก API\nURL: ${pageUrl}\nกรุณาตรวจสอบ report_code หรือลองใหม่` }],
          isError: true,
        };
      }

      if (!data.ok) {
        return {
          content: [{
            type: "text",
            text: [
              `API ตอบกลับผิดพลาด: ${data.message ?? "unknown"} (code ${data.code})`,
              `Data API: ${interceptedUrl}`,
            ].join("\n"),
          }],
          isError: true,
        };
      }

      // ── Metadata ──
      const info = capturedInfo as InfoApiResponse | null;
      const reportName    = info?.ok ? info.rows.report_name              : code;
      const catMain       = info?.ok ? (info.rows.category_main_name ?? "") : "";
      const catSub        = info?.ok ? (info.rows.category_sub_name  ?? "") : "";
      const byears        = info?.ok ? (info.rows.byear_list          ?? []) : [];
      const displayOpts   = info?.ok ? (info.rows.table_display        ?? []) : [];

      // ── Format Table ──
      const tableText = formatTable(data.rows);
      const rowCount  = data.rows?.[0]?.data?.length ?? 0;
      const jsonc     = (data.rows?.[0]?.jsonc ?? []) as JsoncCol[];

      const filterDesc = [
        `ปี: ${year}`,
        zone === "ALL"          ? "เขตสุขภาพ: ทั้งหมด"    : `เขตสุขภาพ: เขต ${zone}`,
        province_code === "ALL" ? "จังหวัด: ทั้งหมด"      : `จังหวัด: ${province_code}`,
        `แสดงตาม: ${table_display}`,
        month === "ALL"         ? "เดือน: ทั้งหมด"        : `เดือน: ${month}`,
      ].join(" | ");

      const colDesc = jsonc.map((c: JsoncCol) => c.column_name).join(", ");

      const output = [
        `=== ${reportName} ===`,
        [catMain, catSub].filter(Boolean).join(" > "),
        ``,
        `ตัวกรอง : ${filterDesc}`,
        `คอลัมน์  : ${colDesc}`,
        byears.length     ? `ปีที่มีข้อมูล : ${byears.join(", ")}` : "",
        displayOpts.length ? `รูปแบบ : ${displayOpts.map((d) => `${d.value}=${d.name}`).join(", ")}` : "",
        `จำนวนแถว : ${rowCount}`,
        ``,
        tableText,
        ``,
        `API: ${interceptedUrl || pageUrl}`,
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      if (browser) await browser.close();
      return {
        content: [{ type: "text", text: `เกิดข้อผิดพลาด: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Tool 2: hdc_search ───────────────────────────────────────────────────────

const HDC_API_BASE = "https://api-hdc.moph.go.th/v1";
const HDC_REPORT_URL = "https://hdc.moph.go.th/center/public/report";

const HDC_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Origin": "https://hdc.moph.go.th",
  "Referer": "https://hdc.moph.go.th/",
};

interface SearchRow {
  report_name: string;
  report_code: string;
  subcatalog_name: string | null;
  subcatalog_id: string | null;
  catalog_name: string | null;
  catalog_id: string | null;
}

interface SearchResponse {
  ok: boolean;
  rows: SearchRow[];
  code: number;
}

server.tool(
  "hdc_search",
  "ค้นหารายงานใน HDC MOPH ผ่าน API (api-hdc.moph.go.th/v1/center/reports?q=) คืน report_name, report_code และ URL ของรายงาน",
  {
    keyword: z.string().describe("คำค้นหา เช่น 'เบาหวาน', 'ความดัน', 'มะเร็ง', 'ANC', 'ทางไกล'"),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("จำนวนผลลัพธ์สูงสุด (default: 20, max: 100)"),
  },
  async ({ keyword, limit = 20 }) => {
    try {
      const apiUrl = `${HDC_API_BASE}/center/reports?q=${encodeURIComponent(keyword)}`;

      const res = await fetch(apiUrl, {
        headers: HDC_FETCH_HEADERS,
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        return {
          content: [{ type: "text", text: `API ตอบกลับ HTTP ${res.status} ${res.statusText}\nURL: ${apiUrl}` }],
          isError: true,
        };
      }

      const data = await res.json() as SearchResponse;

      if (!data.ok || !Array.isArray(data.rows)) {
        return {
          content: [{ type: "text", text: `API ตอบกลับผิดปกติ:\n${JSON.stringify(data, null, 2).slice(0, 500)}` }],
          isError: true,
        };
      }

      if (data.rows.length === 0) {
        return {
          content: [{ type: "text", text: `ไม่พบรายงานที่ตรงกับ "${keyword}"\nAPI: ${apiUrl}` }],
        };
      }

      const rows = data.rows.slice(0, Math.min(limit, 100));

      const lines = [
        `ผลการค้นหา "${keyword}" — พบ ${data.rows.length} รายการ (แสดง ${rows.length} รายการ)`,
        `API: ${apiUrl}`,
        "",
      ];

      rows.forEach((row, i) => {
        const catalog = [row.catalog_name, row.subcatalog_name].filter(Boolean).join(" > ");
        lines.push(`${i + 1}. ${row.report_name}`);
        if (catalog) lines.push(`   หมวด: ${catalog}`);
        lines.push(`   URL: ${HDC_REPORT_URL}/${row.report_code}`);
        lines.push(`   Code: ${row.report_code}`);
        lines.push("");
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `เกิดข้อผิดพลาด: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Tool 3: get_report_template ───────────────────────────────────────────────

server.tool(
  "hdc_template",
  "ดึง template เอกสารของรายงาน HDC — แสดงข้อมูลรายงาน ตัวกรองที่ใช้ได้ และค้นหาไฟล์ PDF template จาก fileex.moph.go.th",
  {
    report_code: z
      .string()
      .describe("report_code (32 ตัว hex) หรือ URL รายงาน เช่น https://hdc.moph.go.th/center/public/standard-report-detail/<code>"),
  },
  async ({ report_code }) => {
    try {
      const code = extractReportCode(report_code);
      if (!code || code.length < 10) {
        return {
          content: [{ type: "text", text: `report_code ไม่ถูกต้อง: "${report_code}"` }],
          isError: true,
        };
      }

      const infoUrl = `https://api-center-hdc.moph.go.th/v1/report-public/info?reportCode=${code}&subCatalogId=`;
      const reportPageUrl = `${HDC_BASE_URL}/public/standard-report-detail/${code}`;
      const fileexBase = `https://fileex.moph.go.th/media`;

      // ── Step 1: ดึง report info ──
      const infoRes = await fetch(infoUrl, {
        headers: { ...HDC_FETCH_HEADERS, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });

      if (!infoRes.ok) {
        return {
          content: [{ type: "text", text: `ดึง report info ไม่สำเร็จ HTTP ${infoRes.status}\nURL: ${infoUrl}` }],
          isError: true,
        };
      }

      const info = await infoRes.json() as InfoApiResponse;
      if (!info.ok) {
        return {
          content: [{ type: "text", text: `API ตอบกลับ ok=false\nURL: ${infoUrl}` }],
          isError: true,
        };
      }

      const {
        report_name,
        category_main_name,
        category_sub_name,
        byear_list = [],
        table_display = [],
        source_table,
        seletype,
        table_freeze = [],
      } = info.rows;

      // ── Step 2: ค้นหา PDF templates จาก fileex.moph.go.th ──
      // probe ทุกปีใน byear_list พร้อมกัน
      const pdfChecks = await Promise.all(
        byear_list.map(async (year) => {
          const pdfUrl = `${fileexBase}/${code}-${year}.pdf`;
          try {
            const r = await fetch(pdfUrl, {
              method: "GET",
              signal: AbortSignal.timeout(8000),
              headers: { "User-Agent": HDC_FETCH_HEADERS["User-Agent"] },
            });
            return { year, url: pdfUrl, available: r.ok, status: r.status };
          } catch {
            return { year, url: pdfUrl, available: false, status: 0 };
          }
        })
      );

      const availablePdfs = pdfChecks.filter((p) => p.available);
      const unavailablePdfs = pdfChecks.filter((p) => !p.available);

      // ── Step 3: format output ──
      const parts: string[] = [
        `=== Template รายงาน ===`,
        `ชื่อรายงาน : ${report_name}`,
        `หมวดหมู่   : ${[category_main_name, category_sub_name].filter(Boolean).join(" > ")}`,
        `ตารางข้อมูล: ${source_table ?? "-"}`,
        ``,
      ];

      // ตัวกรอง
      parts.push(`--- ตัวกรองที่ใช้ได้ ---`);
      parts.push(`ปีงบประมาณ : ${byear_list.join(", ")}`);
      if (table_display.length > 0) {
        parts.push(`แสดงตาม   : ${table_display.map((d) => `${d.value} (${d.name})`).join(", ")}`);
      }
      if (seletype) {
        parts.push(`ประเภทพื้นที่: ${seletype}`);
      }

      // freeze dates (3 ล่าสุด)
      if (table_freeze.length > 0) {
        const recent = table_freeze.slice(0, 3);
        parts.push(`วันที่อัปเดตล่าสุด: ${recent.join(", ")}${table_freeze.length > 3 ? ` (+${table_freeze.length - 3} เพิ่มเติม)` : ""}`);
      }

      parts.push(``);

      // PDF templates
      parts.push(`--- ไฟล์ PDF Template (fileex.moph.go.th) ---`);
      if (availablePdfs.length > 0) {
        parts.push(`พบ ${availablePdfs.length} ไฟล์:`);
        availablePdfs.forEach((p) => {
          parts.push(`  ✓ ปี ${p.year}: ${p.url}`);
        });
      } else {
        parts.push(`ไม่พบไฟล์ PDF template สำหรับรายงานนี้`);
      }

      if (unavailablePdfs.length > 0) {
        parts.push(`ไม่มีไฟล์ (${unavailablePdfs.map((p) => `ปี ${p.year}`).join(", ")})`);
      }

      parts.push(``);
      parts.push(`--- ลิงก์ ---`);
      parts.push(`รายงาน: ${reportPageUrl}`);
      parts.push(`Info API: ${infoUrl}`);

      return { content: [{ type: "text", text: parts.join("\n") }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `เกิดข้อผิดพลาด: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Tool 4: list_hdc_areas ────────────────────────────────────────────────────

server.tool(
  "hdc_areas",
  "แสดงรายชื่อเขตสุขภาพ และจังหวัดในระบบ HDC MOPH พร้อม code ที่ใช้ใน URL",
  {
    area_type: z
      .enum(["health_region", "province", "district"])
      .optional()
      .default("health_region")
      .describe("ประเภทพื้นที่: health_region=เขตสุขภาพ, province=จังหวัด, district=อำเภอ"),
    region_id: z
      .string()
      .optional()
      .describe("รหัสเขตสุขภาพ (1-13) สำหรับกรองจังหวัด/อำเภอในเขตนั้น"),
  },
  async ({ area_type, region_id }) => {
    // ข้อมูลเขตสุขภาพและจังหวัดของประเทศไทย (ข้อมูลคงที่ ไม่ต้อง scrape)
    const healthRegions: Record<string, { name: string; provinces: Array<{ code: string; name: string }> }> = {
      "1":  { name: "เขตสุขภาพที่ 1 (ภาคเหนือตอนบน)",  provinces: [{ code: "50", name: "เชียงใหม่" }, { code: "57", name: "เชียงราย" }, { code: "55", name: "น่าน" }, { code: "54", name: "แพร่" }, { code: "51", name: "ลำพูน" }, { code: "52", name: "ลำปาง" }, { code: "56", name: "พะเยา" }, { code: "58", name: "แม่ฮ่องสอน" }] },
      "2":  { name: "เขตสุขภาพที่ 2 (ภาคเหนือตอนล่าง 1)", provinces: [{ code: "65", name: "พิษณุโลก" }, { code: "64", name: "สุโขทัย" }, { code: "63", name: "ตาก" }, { code: "66", name: "พิจิตร" }, { code: "67", name: "เพชรบูรณ์" }] },
      "3":  { name: "เขตสุขภาพที่ 3 (ภาคเหนือตอนล่าง 2)", provinces: [{ code: "60", name: "นครสวรรค์" }, { code: "62", name: "กำแพงเพชร" }, { code: "61", name: "อุทัยธานี" }, { code: "53", name: "อุตรดิตถ์" }] },
      "4":  { name: "เขตสุขภาพที่ 4 (ภาคกลางตอนบน)",    provinces: [{ code: "12", name: "นนทบุรี" }, { code: "13", name: "ปทุมธานี" }, { code: "19", name: "สระบุรี" }, { code: "16", name: "ลพบุรี" }, { code: "17", name: "สิงห์บุรี" }, { code: "18", name: "อ่างทอง" }, { code: "15", name: "นครนายก" }, { code: "14", name: "พระนครศรีอยุธยา" }] },
      "5":  { name: "เขตสุขภาพที่ 5 (ภาคกลาง)",          provinces: [{ code: "71", name: "กาญจนบุรี" }, { code: "72", name: "สุพรรณบุรี" }, { code: "73", name: "นครปฐม" }, { code: "75", name: "สมุทรสงคราม" }, { code: "74", name: "สมุทรสาคร" }, { code: "76", name: "เพชรบุรี" }, { code: "77", name: "ประจวบคีรีขันธ์" }, { code: "70", name: "ราชบุรี" }] },
      "6":  { name: "เขตสุขภาพที่ 6 (ภาคตะวันออก)",      provinces: [{ code: "20", name: "ชลบุรี" }, { code: "21", name: "ระยอง" }, { code: "22", name: "จันทบุรี" }, { code: "23", name: "ตราด" }, { code: "24", name: "ฉะเชิงเทรา" }, { code: "25", name: "ปราจีนบุรี" }, { code: "27", name: "สระแก้ว" }] },
      "7":  { name: "เขตสุขภาพที่ 7 (ภาคตะวันออกเฉียงเหนือตอนบน 1)", provinces: [{ code: "40", name: "ขอนแก่น" }, { code: "44", name: "มหาสารคาม" }, { code: "45", name: "ร้อยเอ็ด" }, { code: "46", name: "กาฬสินธุ์" }] },
      "8":  { name: "เขตสุขภาพที่ 8 (ภาคตะวันออกเฉียงเหนือตอนบน 2)", provinces: [{ code: "41", name: "อุดรธานี" }, { code: "43", name: "หนองคาย" }, { code: "42", name: "หนองบัวลำภู" }, { code: "49", name: "มุกดาหาร" }, { code: "47", name: "สกลนคร" }, { code: "48", name: "นครพนม" }, { code: "38", name: "บึงกาฬ" }] },
      "9":  { name: "เขตสุขภาพที่ 9 (ภาคตะวันออกเฉียงเหนือตอนล่าง 1)", provinces: [{ code: "30", name: "นครราชสีมา" }, { code: "31", name: "บุรีรัมย์" }, { code: "32", name: "สุรินทร์" }, { code: "33", name: "ศรีสะเกษ" }] },
      "10": { name: "เขตสุขภาพที่ 10 (ภาคตะวันออกเฉียงเหนือตอนล่าง 2)", provinces: [{ code: "34", name: "อุบลราชธานี" }, { code: "35", name: "ยโสธร" }, { code: "36", name: "ชัยภูมิ" }, { code: "37", name: "อำนาจเจริญ" }] },
      "11": { name: "เขตสุขภาพที่ 11 (ภาคใต้ตอนบน)",     provinces: [{ code: "80", name: "นครศรีธรรมราช" }, { code: "84", name: "สุราษฎร์ธานี" }, { code: "85", name: "ระนอง" }, { code: "81", name: "กระบี่" }, { code: "82", name: "พังงา" }, { code: "83", name: "ภูเก็ต" }, { code: "86", name: "ชุมพร" }] },
      "12": { name: "เขตสุขภาพที่ 12 (ภาคใต้ตอนล่าง)",   provinces: [{ code: "90", name: "สงขลา" }, { code: "91", name: "สตูล" }, { code: "92", name: "ตรัง" }, { code: "93", name: "พัทลุง" }, { code: "94", name: "ปัตตานี" }, { code: "95", name: "ยะลา" }, { code: "96", name: "นราธิวาส" }] },
      "13": { name: "เขตสุขภาพที่ 13 (กรุงเทพมหานคร)",   provinces: [{ code: "10", name: "กรุงเทพมหานคร" }] },
    };

    if (area_type === "health_region" || !area_type) {
      const lines = [
        "=== เขตสุขภาพทั้งหมดในระบบ HDC MOPH ===",
        "",
        "การใช้งานใน URL: ?area_id=<รหัสเขต> หรือ ?province_id=<รหัสจังหวัด>",
        "",
        ...Object.entries(healthRegions).map(([id, r]) =>
          `เขต ${id}: ${r.name}\n  จังหวัด: ${r.provinces.map((p) => `${p.name}(${p.code})`).join(", ")}`
        ),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (area_type === "province") {
      if (region_id && healthRegions[region_id]) {
        const region = healthRegions[region_id];
        const lines = [
          `=== จังหวัดในเขตสุขภาพที่ ${region_id}: ${region.name} ===`,
          "",
          "รหัส | จังหวัด",
          "-----|---------",
          ...region.provinces.map((p) => `${p.code}  | ${p.name}`),
          "",
          `ใช้ใน URL: ?province_id=<รหัส>`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ทุกจังหวัด
      const allProvinces = Object.entries(healthRegions).flatMap(([rid, r]) =>
        r.provinces.map((p) => ({ ...p, region: rid }))
      ).sort((a, b) => parseInt(a.code) - parseInt(b.code));

      const lines = [
        "=== จังหวัดทั้งหมดในระบบ HDC MOPH ===",
        "",
        "รหัส | จังหวัด          | เขตสุขภาพ",
        "-----|------------------|----------",
        ...allProvinces.map((p) => `${p.code.padEnd(4)} | ${p.name.padEnd(16)} | ${p.region}`),
        "",
        "ใช้ใน URL: ?province_id=<รหัส>",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // district — ต้อง scrape จากเว็บ
    if (!region_id) {
      return {
        content: [{ type: "text", text: "สำหรับ district กรุณาระบุ region_id (1-13) ด้วยครับ" }],
      };
    }

    let browser: Browser | undefined;
    try {
      browser = await launchBrowser();
      const page = await setupPage(browser);

      const region = healthRegions[region_id];
      if (!region) {
        return { content: [{ type: "text", text: `ไม่พบเขตสุขภาพที่ ${region_id}` }] };
      }

      // ดึง dropdown อำเภอจากหน้าหลัก
      await page.goto(`${HDC_BASE_URL}/main/index.php`, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      const districts = await page.evaluate((provinceCode: string) => {
        const selects = Array.from(document.querySelectorAll("select"));
        for (const select of selects) {
          if (select.name?.includes("district") || select.id?.includes("district") ||
              select.name?.includes("amphoe") || select.id?.includes("amphoe")) {
            return Array.from(select.options).map((o) => ({
              code: o.value,
              name: o.text.trim(),
            })).filter((o) => o.code && o.name);
          }
        }
        return [];
      }, region.provinces[0]?.code ?? "");

      await browser.close();

      if (districts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `ไม่สามารถดึงข้อมูลอำเภอได้จากหน้า HDC โดยตรง\nลองระบุ province_id ใน URL ของรายงานแทน\n\nจังหวัดในเขต ${region_id}:\n${region.provinces.map((p) => `- ${p.name} (${p.code})`).join("\n")}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `อำเภอในเขต ${region_id}:\n${districts.map((d) => `${d.code}: ${d.name}`).join("\n")}`,
          },
        ],
      };
    } catch (error) {
      if (browser) await browser.close();
      return {
        content: [{ type: "text", text: `เกิดข้อผิดพลาด: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Tool 5: fetch_hdc_page_content ────────────────────────────────────────────

server.tool(
  "hdc_page",
  "ดึง content ทั้งหมดจากหน้า HDC — ทั้งข้อความ ลิงก์ และข้อมูล ไม่จำกัดแค่ตาราง เหมาะสำหรับหน้า dashboard หรือ summary",
  {
    url: z.string().describe("URL ของหน้า HDC ที่ต้องการดึง content"),
    extract_links: z
      .boolean()
      .optional()
      .default(true)
      .describe("true = ดึง links ทั้งหมดในหน้าด้วย"),
    content_selector: z
      .string()
      .optional()
      .describe("CSS selector สำหรับ element ที่ต้องการ เช่น '.main-content', '#report-area'"),
  },
  async ({ url, extract_links, content_selector }) => {
    let browser: Browser | undefined;
    try {
      browser = await launchBrowser();
      const page = await setupPage(browser);

      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

      const content = await page.evaluate(
        (selector: string | undefined, getLinks: boolean) => {
          const target = selector
            ? document.querySelector(selector)
            : document.body;

          if (!target) return { text: "ไม่พบ element ที่ระบุ", links: [], title: document.title };

          // ดึงข้อความหลัก
          const text = (target as HTMLElement).innerText
            ?.replace(/\n{3,}/g, "\n\n")
            .trim() ?? "";

          // ดึง links
          const links: Array<{ text: string; url: string }> = [];
          if (getLinks) {
            Array.from(target.querySelectorAll("a[href]")).forEach((a) => {
              const linkText = (a as HTMLElement).innerText?.trim() || a.getAttribute("title") || "";
              const href = a.getAttribute("href") || "";
              if (linkText && href && href !== "#" && !href.startsWith("javascript")) {
                const fullUrl = href.startsWith("http")
                  ? href
                  : href.startsWith("/")
                  ? `https://hdc.moph.go.th${href}`
                  : `https://hdc.moph.go.th/hdc/${href}`;
                links.push({ text: linkText, url: fullUrl });
              }
            });
          }

          return {
            title: document.title,
            text: text.slice(0, 8000), // จำกัดขนาด
            links: links.slice(0, 50), // จำกัด 50 links
            textLength: text.length,
          };
        },
        content_selector,
        extract_links ?? true
      );

      await browser.close();

      const parts = [
        `=== ${content.title} ===`,
        `URL: ${url}`,
        "",
        "--- เนื้อหาหน้า ---",
        content.text,
      ];

      if ((content.textLength ?? 0) > 8000) {
        parts.push(`\n[ข้อความถูกตัดที่ 8,000 ตัวอักษร จากทั้งหมด ${content.textLength} ตัวอักษร]`);
      }

      if ((extract_links ?? true) && content.links.length > 0) {
        parts.push(`\n--- Links (${content.links.length} รายการ) ---`);
        content.links.forEach((l, i) => {
          parts.push(`${i + 1}. ${l.text} → ${l.url}`);
        });
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    } catch (error) {
      if (browser) await browser.close();
      return {
        content: [{ type: "text", text: `เกิดข้อผิดพลาด: ${(error as Error).message}` }],
        isError: true,
      };
    }
  }
);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("HDC MCP Server v2.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
