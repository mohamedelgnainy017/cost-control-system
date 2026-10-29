# LINK-BASELINE — استعلامات قياس الربط (Reference Link Baseline)

> غرض هذا الملف: قياس «صحة الربط» بين الجداول المرجعية والجداول اليومية/التعاقدية في قاعدة
> `costcontrol` — **بدون تنفيذ إلزامي**. الاستعلامات أدناه جاهزة للتشغيل عند الحاجة
> (psql / pgAdmin / أي عميل). لا تعدّل أي ملف آخر عند استخدام هذا المرجع.

## الجداول المعنية

| الجدول | الدور | المفاتيح المستخدمة |
|---|---|---|
| `contract_items` | مرجع الأصناف/التصنيفات (من PBIX `الاصناف`) | `code` (PK), `name` (= التصنيف) |
| `items` | أصناف المستودع + المجموعات/التصنيفات كصفوف (`kind`) | `code`, `group_code`, `kind='item'` |
| `contract_balances` | أرصدة تقرير التعاقدات (Excel) | `item_code`, `item_desc`, `report_date` |
| `contract_registrations` | تسجيل العقود | `classification` |

سلسلة الربط المعتمدة في المحرك: `contract_balances.item_code` → `contract_items.code`،
و `items.code` → `items.group_code` → `contract_items.code` (ثم `name` = التصنيف).

---

## 1) عدد `contract_items` ونسبة من له `code` غير فارغ

```sql
-- 1) اكتمال مفتاح الربط في مرجع الأصناف
SELECT
  COUNT(*)                                                          AS total_items,
  COUNT(NULLIF(BTRIM(code), ''))                                    AS with_code,
  COUNT(*) - COUNT(NULLIF(BTRIM(code), ''))                         AS blank_code,
  ROUND(100.0 * COUNT(NULLIF(BTRIM(code), '')) / NULLIF(COUNT(*), 0), 2) AS pct_with_code
FROM contract_items;
```

**القراءة المتوقعة:** `pct_with_code` ينبغي أن يكون **100.00** (كل صف `contract_items` له كود).
أي نقص = صفوف بلا كود لن تُربط لاحقاً بـ `contract_balances` ولا بـ `items.group_code`.

كشف الصفوف الفارغة (إن وُجدت):

```sql
SELECT code, name
FROM contract_items
WHERE NULLIF(BTRIM(code), '') IS NULL
ORDER BY name;
```

---

## 2) تطابق `contract_items.code` مع `items.group_code`

```sql
-- 2) هل كل تصنيف في مرجع التعاقدات موجود كمجموعة في جدول الأصناف؟
SELECT
  COUNT(*)                                                          AS contract_items_total,
  COUNT(i.group_code)                                               AS matched_in_items,
  COUNT(*) - COUNT(i.group_code)                                    AS unmatched,
  ROUND(100.0 * COUNT(i.group_code) / NULLIF(COUNT(*), 0), 2)       AS pct_matched
FROM contract_items ci
LEFT JOIN (
  SELECT DISTINCT BTRIM(group_code) AS group_code
  FROM items
  WHERE kind = 'item'
    AND NULLIF(BTRIM(group_code), '') IS NOT NULL
) i ON i.group_code = BTRIM(ci.code);
```

**القراءة المتوقعة:** `pct_matched` ≈ **100.00** — كل `contract_items.code` له مقابل
`items.group_code` (الأكواد 4-رقمية: 1001، 1002، 1004 …).

قائمة غير المتطابق (drill-down):

```sql
SELECT ci.code, ci.name
FROM contract_items ci
LEFT JOIN (
  SELECT DISTINCT BTRIM(group_code) AS group_code
  FROM items WHERE kind = 'item'
) i ON i.group_code = BTRIM(ci.code)
WHERE i.group_code IS NULL
ORDER BY ci.code;
```

الاتجاه المعاكس — مجموعات في `items` بلا مرجع في `contract_items`:

```sql
SELECT DISTINCT BTRIM(i.group_code) AS group_code, i.group_desc
FROM items i
LEFT JOIN contract_items ci ON ci.code = BTRIM(i.group_code)
WHERE i.kind = 'item'
  AND NULLIF(BTRIM(i.group_code), '') IS NOT NULL
  AND ci.code IS NULL
ORDER BY 1;
```

---

## 3) تطابق `contract_balances.item_code` مع `contract_items.code`

```sql
-- 3) هل كل صف رصيد له مرجع صنف؟ (على مستوى الصفوف وعلى مستوى الأكواد المميّزة)
SELECT
  COUNT(*)                                                          AS balance_rows,
  COUNT(ci.code)                                                    AS matched_rows,
  COUNT(*) - COUNT(ci.code)                                         AS unmatched_rows,
  ROUND(100.0 * COUNT(ci.code) / NULLIF(COUNT(*), 0), 2)            AS pct_rows_matched,
  COUNT(DISTINCT BTRIM(b.item_code))                                AS distinct_codes,
  COUNT(DISTINCT ci.code)                                           AS distinct_matched
FROM contract_balances b
LEFT JOIN contract_items ci ON ci.code = BTRIM(b.item_code);
```

**القراءة المتوقعة:** `pct_rows_matched` ≈ **100.00** (كل `item_code` في الأرصدة موجود في
`contract_items`). الفارق يشير إلى أكواد قديمة/مقصوصة/فارغة.

تفصيل الصفوف غير المتطابقة:

```sql
SELECT BTRIM(b.item_code) AS item_code, b.item_desc, COUNT(*) AS rows
FROM contract_balances b
LEFT JOIN contract_items ci ON ci.code = BTRIM(b.item_code)
WHERE ci.code IS NULL
GROUP BY 1, 2
ORDER BY rows DESC;
```

---

## 4) أكثر قيم `classification` تكراراً في `contract_registrations`

```sql
-- 4) توزيع التصنيفات في تسجيل العقود
SELECT
  COALESCE(NULLIF(BTRIM(classification), ''), '(فارغ)')             AS classification,
  COUNT(*)                                                          AS cnt,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2)                AS pct
FROM contract_registrations
GROUP BY 1
ORDER BY cnt DESC, classification
LIMIT 20;
```

**القراءة المتوقعة:** القيم تطابق `contract_items.name` (الـ التصنيفات مثل: `الــــــــــذرة`،
`الصويا`، `البذرة`، `دوار الشمس`، `دى جى اس`). أي قيمة غير موجودة في `contract_items.name`
= تصنيف «يتيم» لا يظهر في مقاييس التقارير.

كشف التصنيفات غير المطابقة لمرجع الأصناف:

```sql
SELECT COALESCE(NULLIF(BTRIM(r.classification), ''), '(فارغ)') AS classification,
       COUNT(*) AS cnt
FROM contract_registrations r
LEFT JOIN contract_items ci ON ci.name = BTRIM(r.classification)
WHERE ci.code IS NULL
GROUP BY 1
ORDER BY cnt DESC;
```

---

## ملخّص القياس (Baseline)

| # | المقياس | القيمة المرجعية المستهدفة |
|---|---|---|
| 1 | `pct_with_code` في `contract_items` | 100.00% |
| 2 | `pct_matched` (code ↔ items.group_code) | ~100% |
| 3 | `pct_rows_matched` (item_code ↔ contract_items.code) | ~100% |
| 4 | أعلى تكرار في `classification` | مطابق لقيم `contract_items.name` |

للتحقق البرمجي من نفس السلوك يمكن تشغيل حزمة الانحدار:
`node tests/test-md.js` (لا تنفّذها من هذا الملف — للمرجع فقط).
