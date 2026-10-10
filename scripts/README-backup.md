# النسخ الاحتياطي (قرار الاحتفاظ الدائم)

مع قرار **الاحتفاظ الدائم بلا حذف**، برنامج النسخ الاحتياطي إلزامي:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
```

- تنسيق `-Fc` (مضغوط مخصّص لـ PostgreSQL) → يُستعاد بـ:
  `pg_restore --clean --if-exists -d costcontrol <الملف.dump>`
- يحتفظ بآخر **14 نسخة** ويحذف الأقدم تلقائياً.
- يقرأ بيانات الاتصال من `data/config.json` (نفس ملف النظام).

## الجدولة اليومية

افتح **Task Scheduler** ← `إنشاء مهمة أساسية`:
- المشغّل: يومياً بعد موعد الاستيراد المعتاد (مثلاً 18:00).
- الإجراء: `powershell.exe` مع وسائط:
  `-ExecutionPolicy Bypass -File "C:\...\cost-control-system\scripts\backup.ps1"`
- التشغيل بحسابك (بكلمة المرور) أو بحساب خدمة.

## ملاحظة OneDrive

المشروع داخل مجلد `OneDrive\Documents` — النسخة قد تصل لمئات الـ MB.
أنصح بوضع `backups\` خارج المجلد المتزامن أو استثناؤه من المزامنة،
وإلا فكل نسخة يومية ستُرفع/تتزامن مع السحابة.