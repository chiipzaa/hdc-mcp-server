# HDC MCP Server

MCP Server สำหรับดึงข้อมูลจากระบบ [Health Data Center (HDC)](https://hdc.moph.go.th) กระทรวงสาธารณสุข รองรับการค้นหารายงาน ดึงข้อมูลพร้อมตัวกรองเขตสุขภาพ/จังหวัด และดูโครงสร้างรายงาน

## เครื่องมือ (Tools)

### `hdc_search` — ค้นหารายงาน

ค้นหารายงานผ่าน API `api-hdc.moph.go.th/v1/center/reports?q=` คืนชื่อรายงาน, รหัส (`report_code`) และ URL พร้อมใช้งาน

| Parameter | Type | Default | คำอธิบาย |
|-----------|------|---------|-----------|
| `keyword` | string | — | คำค้นหา เช่น `เบาหวาน`, `ทางไกล`, `ANC` |
| `limit` | number | `20` | จำนวนผลลัพธ์สูงสุด (max 100) |

**ตัวอย่าง**

```
ค้นหารายงานเกี่ยวกับ "ทางไกล"
→ hdc_search(keyword="ทางไกล")
```

---

### `hdc_get` — ดึงข้อมูลรายงาน

ดึงข้อมูลรายงาน HDC พร้อมตัวกรองพื้นที่และปีงบประมาณ ใช้ **Request Interception** เพื่อแทรก filter params เข้าใน Angular's native request ทำให้ผ่าน session authentication ได้อัตโนมัติ

| Parameter | Type | Default | คำอธิบาย |
|-----------|------|---------|-----------|
| `report_code` | string | — | รหัสรายงาน 32 หลัก หรือ URL เต็ม เช่น `https://hdc.moph.go.th/center/public/standard-report-detail/<code>` |
| `year` | number | `2569` | ปีงบประมาณ (พ.ศ.) เช่น `2569`, `2568` |
| `zone` | string | `ALL` | เขตสุขภาพ: `ALL` หรือ `1`–`13` |
| `province_code` | string | `ALL` | รหัสจังหวัด 2 หลัก เช่น `90`=สงขลา, `80`=นครศรีฯ |
| `table_display` | string | `zone` | จัดกลุ่มข้อมูลตาม: `zone` / `province` / `district` |
| `month` | string | `ALL` | เดือน: `ALL` หรือ `1`–`12` |

**ตัวอย่าง**

```
ดูข้อมูลเขต 12 ระดับจังหวัด ปี 2569
→ hdc_get(
    report_code="cbd664002bac0b8f0ed57ccba8bfad19",
    zone="12",
    table_display="province",
    year=2569
  )
```

ผลลัพธ์:

```
=== จังหวัดที่มีบริการการแพทย์ทางไกลตามเกณฑ์ที่กำหนด ===
การใช้บริการสาธารณสุข > การเข้าถึงบริการ

ตัวกรอง : ปี: 2569 | เขตสุขภาพ: เขต 12 | จังหวัด: ทั้งหมด | แสดงตาม: province | เดือน: ทั้งหมด
คอลัมน์  : a_name, total, result, pass

a_name   | total | result | pass
---------+-------+--------+-----
สงขลา    | 1     | 39250  | 1
สตูล     | 1     | 13396  | 1
ตรัง     | 1     | 16117  | 1
พัทลุง   | 1     | 11276  | 1
ปัตตานี  | 1     | 3423   | 0
ยะลา     | 1     | 9120   | 1
นราธิวาส | 1     | 11782  | 1
```

---

### `hdc_template` — ดูโครงสร้างรายงาน

แสดง template ของรายงาน ได้แก่ ตัวกรอง (filters/parameters) หัวคอลัมน์ และข้อมูลตัวอย่าง

| Parameter | Type | Default | คำอธิบาย |
|-----------|------|---------|-----------|
| `url` | string | — | URL ของหน้ารายงาน |
| `include_sample_data` | boolean | `false` | `true` = ดึงข้อมูลตัวอย่าง 3 แถวแรกด้วย |

---

### `hdc_areas` — รายชื่อพื้นที่

แสดงรายชื่อเขตสุขภาพ จังหวัด หรืออำเภอ พร้อมรหัสที่ใช้ใน API

| Parameter | Type | Default | คำอธิบาย |
|-----------|------|---------|-----------|
| `area_type` | string | `health_region` | `health_region` / `province` / `district` |
| `region_id` | string | — | รหัสเขตสุขภาพ `1`–`13` (ใช้กับ province/district) |

**ตัวอย่าง**

```
ดูจังหวัดทั้งหมดในเขต 12
→ hdc_areas(area_type="province", region_id="12")
```

---

### `hdc_page` — ดึง Content หน้าเว็บ

ดึงข้อความและลิงก์จากหน้า HDC แบบ full-page เหมาะสำหรับหน้า Dashboard หรือ Summary ที่ไม่ใช่ตาราง

| Parameter | Type | Default | คำอธิบาย |
|-----------|------|---------|-----------|
| `url` | string | — | URL ของหน้า HDC |
| `extract_links` | boolean | `true` | ดึงลิงก์ทั้งหมดในหน้าด้วย |
| `content_selector` | string | — | CSS selector เช่น `.main-content` |

---

## วิธีการติดตั้ง

### ข้อกำหนดเบื้องต้น

- [Node.js](https://nodejs.org/) v18 ขึ้นไป
- [npm](https://www.npmjs.com/) หรือ [yarn](https://yarnpkg.com/)
- [Claude Desktop](https://claude.ai/download) (สำหรับใช้งานผ่าน Claude)

### 1. Clone repository

```bash
git clone https://github.com/<your-username>/hdc-mcp-server.git
cd hdc-mcp-server
```

### 2. ติดตั้ง dependencies

```bash
npm install
```

> Puppeteer จะดาวน์โหลด Chromium อัตโนมัติระหว่างติดตั้ง (~200 MB)

### 3. Build

```bash
npm run build
```

ไฟล์ที่ build แล้วจะอยู่ที่ `build/index.js`

### 4. ตั้งค่า Claude Desktop

เปิดไฟล์ config ของ Claude Desktop:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

เพิ่ม block ต่อไปนี้ใน `mcpServers`:

```json
{
  "mcpServers": {
    "hdc-explorer": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/TO/hdc-mcp-server/build/index.js"
      ]
    }
  }
}
```

> แทน `/ABSOLUTE/PATH/TO/` ด้วย path จริงของโปรเจกต์

### 5. Restart Claude Desktop

ปิดและเปิด Claude Desktop ใหม่ MCP server จะ active ทันที

---

## สถาปัตยกรรม

```
Claude Desktop
    │  MCP Protocol (stdio)
    ▼
hdc-mcp-server (Node.js)
    ├── hdc_search  → fetch()  → api-hdc.moph.go.th/v1/center/reports
    ├── hdc_get     → Puppeteer (Request Interception)
    │                   └── hdc.moph.go.th/center/public/standard-report-detail/<code>
    │                         └── intercept → api-hdc.moph.go.th/v1/reports/province/data/<code>
    ├── hdc_template → Puppeteer → hdc.moph.go.th (any report URL)
    ├── hdc_areas   → ข้อมูลคงที่ (13 เขตสุขภาพ / 77 จังหวัด)
    └── hdc_page    → Puppeteer → hdc.moph.go.th (any page)
```

**เหตุผลที่ใช้ Request Interception ใน `hdc_get`**

HDC ใช้ Angular SPA ที่ต้องการ session cookie และ DB connection sequence ที่ตั้งค่าผ่าน Angular's boot process — การ fetch ตรงจาก Node.js จะได้ `502 Connection "DBNEW_undefined" not found` Puppeteer ให้เราแทรก filter params เข้าใน Angular's own request โดยที่ cookies และ headers ยังคงถูกต้อง

---

## Dependencies

| Package | เวอร์ชัน | การใช้งาน |
|---------|---------|-----------|
| `@modelcontextprotocol/sdk` | ^1.29.0 | MCP Server framework |
| `puppeteer` | ^24.43.0 | Browser automation + Request Interception |
| `zod` | (via SDK) | Schema validation |
| `typescript` | ^6.0.3 | Dev — type checking |

---

## License

ISC
