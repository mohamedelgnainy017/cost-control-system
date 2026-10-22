let
    Source = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true){[Name="تسجيل_العقود"]}[Data],
    #"اضافة عمود ترقيم تلقائى" = Table.AddIndexColumn(Source, "AUTO", 1, 1, Int64.Type),
    #"تغير نوع البيانات" = Table.TransformColumnTypes(#"اضافة عمود ترقيم تلقائى",{{"الرقم داخلي", type text}, {"تصنيف التعاقد", type text}, {"نوع التعاقد", type text}, {"تاريخ التعاقد", type date}, {"التصنيف", type text}, {"المورد", type text}, {"المصدر", type text}, {"شركة التعاقد", type text}, {"رقم العقد", type text}, {"الكمية", type number}, {"بريم التعاقد", Currency.Type}, {"بورصة التعاقد", type date},  {"الشحن", type text}, {"قيمة الشحن", type number}, {"ملاحظات التسجيل", type text}, {"موقف العقد", type text}, {"متوقع سداد", type date}, {"سعر CIF متوقع", type number}}),
    #"دمج مع جدول الاصناف" = Table.NestedJoin(#"تغير نوع البيانات", {"التصنيف"}, الاصناف, {"اسم الصنف"}, "الاصناف", JoinKind.LeftOuter),
    #"توسيع مع جدول الاصناف" = Table.ExpandTableColumn(#"دمج مع جدول الاصناف", "الاصناف", {"كود الصنف"}, {"كود الصنف"}),
    tfy_wb = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true),
    tfy_sel = Table.SelectRows(tfy_wb, each [Kind] = "Sheet" and [Name] = "تفصيلى"),
    tfy_src = tfy_sel{0}[Data],
    tfy_ph = Table.PromoteHeaders(tfy_src, [PromoteAllScalars=true]),
    tfy_typed = Table.TransformColumnTypes(tfy_ph,{{"الرقم داخلي", type text}}),
    tfy_grp = Table.Group(tfy_typed, {"الرقم داخلي"}, {{"الباخرة", each List.Min([الباخرة]), type any}, {"ميناء الوصول", each List.Min([ميناء الوصول]), type any}, {"وصول متوقع", each List.Min([وصول متوقع]), type any}, {"بداية تشغيل", each List.Min([بداية تشغيل]), type any}, {"مدة التحميل", each List.Min([مدة التحميل]), type any}, {"نهاية تشغيل", each List.Min([نهاية تشغيل]), type any}, {"موقف المركب", each List.Min([موقف المركب]), type any}}),
    tfy_join = Table.NestedJoin(#"توسيع مع جدول الاصناف", {"الرقم داخلي"}, tfy_grp, {"الرقم داخلي"}, "تفصيلى", JoinKind.LeftOuter),
    tfy_exp = Table.ExpandTableColumn(tfy_join, "تفصيلى", {"وصول متوقع", "الباخرة", "ميناء الوصول", "بداية تشغيل", "مدة التحميل", "نهاية تشغيل", "موقف المركب"}, {"وصول متوقع", "الباخرة", "ميناء الوصول", "بداية تشغيل", "مدة التحميل", "نهاية تشغيل", "موقف المركب"}),
    tfy_types = Table.TransformColumnTypes(tfy_exp,{{"وصول متوقع", type date}, {"الباخرة", type text}, {"ميناء الوصول", type text}, {"بداية تشغيل", type date}, {"مدة التحميل", Int64.Type}, {"نهاية تشغيل", type date}, {"موقف المركب", type text}}),
    #"اضافة عمود شهر كميات" = Table.AddColumn(tfy_types, "شهر كميات", each "كميات  " & Date.ToText([وصول متوقع], "MM-yy")),
    #"اضافة عمود شهر عربى" = Table.AddColumn(#"اضافة عمود شهر كميات", "شهر عربي", each Date.ToText([وصول متوقع], [Format="MMMM - yy", Culture="ar-EG"]), type text),
    #"اضافة عمود البريم CIF" = Table.AddColumn(#"اضافة عمود شهر عربى", "البريم CIF", each if [الشحن] = "FOB" then ([قيمة الشحن] / 0.393685) + [بريم التعاقد] 
else if [الشحن] = "CIF" then [بريم التعاقد] 
else null, type number),
    #"دمج مع جدول الربط" = Table.NestedJoin(#"اضافة عمود البريم CIF", {"الرقم داخلي"}, الربط, {"الرقم الداخلي"}, "الربط", JoinKind.LeftOuter),
    #"توسيع مع جدول الربط" = Table.AggregateTableColumn(#"دمج مع جدول الربط", "الربط", {{"كمية الربط", List.Sum, "Sum of كمية الربط", Int64.Type}, {"سعر البورصة", List.Average, "Average of سعر البورصة", type number},{"سعر الربط", List.Average, "Average of سعر الربط", type number}, {"بورصة الربط", List.Max, "Max of بورصة الربط", type date}}),
    #"دمج مع جدول السداد" = Table.NestedJoin(#"توسيع مع جدول الربط", {"الرقم داخلي"}, السداد, {"الرقم الداخلي"}, "السداد", JoinKind.LeftOuter),
    #"توسيع مع جدول السداد" = Table.AggregateTableColumn(#"دمج مع جدول السداد", "السداد", {{"كمية السداد", List.Sum, "Sum of كمية السداد", Int64.Type}, {"سعر السداد", List.Average, "Average of سعر السداد", type number },{"موقف السداد", List.First, "موقف سداد", type text}}),
    #"اضافة عمود السعر CIF" = Table.AddColumn(#"توسيع مع جدول السداد", "السعر CIF", each [Average of سعر السداد]+[قيمة الشحن], type number),
    #"دمج مع جدول التحميل" = Table.NestedJoin(#"اضافة عمود السعر CIF", {"الرقم داخلي"}, التحميل, {"الرقم الداخلي"}, "التحميل", JoinKind.LeftOuter),
    #"توسيع مج جدول التحميل" = Table.AggregateTableColumn(#"دمج مع جدول التحميل", "التحميل", {{"كمية التحميل", List.Sum, "Sum of كمية التحميل", type number}}),
    #"تغير النال الى زيرو" = Table.ReplaceValue(#"توسيع مج جدول التحميل",null,0,Replacer.ReplaceValue,{"Sum of كمية الربط", "Sum of كمية السداد", "Sum of كمية التحميل"}),
    #"اضافة عمود كمية ربط تقديرى" = Table.AddColumn(#"تغير النال الى زيرو", "كمية الربط تقديرى", each if [Sum of كمية الربط] = null or [الكمية] = null then 0
else if [Sum of كمية الربط] > [الكمية] then [الكمية] 
else if Number.Abs([Sum of كمية الربط] - [الكمية]) <= 150 then [الكمية] 
else [Sum of كمية الربط] , type number ),
    #"اضافة عمود موقف التسعير" = Table.AddColumn(#"اضافة عمود كمية ربط تقديرى", "موقف التسعير", each if [Sum of كمية الربط] = null or [Sum of كمية الربط] = 0 then null 
else if Number.From([Sum of كمية الربط]) > Number.From([الكمية]) then "مسعر بالكامل" 
else if (Number.RoundUp(Number.From([Sum of كمية الربط]) / 1000) * 1000) = (Number.RoundUp(Number.From([الكمية]) / 1000) * 1000) then "مسعر بالكامل" 
else if Number.From([Sum of كمية الربط]) < (Number.RoundUp(Number.From([الكمية]) / 1000) * 1000) then "مسعر جزئى" else null, type text),
    #"اضافة عمود موقف السداد" = Table.AddColumn(#"اضافة عمود موقف التسعير", "موقف السداد", each if [موقف سداد] = "منتظر" then null
else if [Sum of كمية السداد] = null or [Sum of كمية السداد] = 0 then null 
else if Number.From([Sum of كمية السداد]) > Number.From([الكمية]) then "مسدد بالكامل" 
else if (Number.RoundUp(Number.From([Sum of كمية السداد]) / 1000) * 1000) = (Number.RoundUp(Number.From([الكمية]) / 1000) * 1000) then "مسدد بالكامل" 
else if Number.From([Sum of كمية السداد]) < (Number.RoundUp(Number.From([الكمية]) / 1000) * 1000) then "مسدد جزئى" 
else null),
    #"اضافة عمود كمية المطلوب سداده" = Table.AddColumn(#"اضافة عمود موقف السداد", "كمية المطلوب سداده", each if [موقف سداد] = "منتظر" then [Sum of كمية السداد]
else if ([الكمية] - [Sum of كمية السداد]) < 200 then 0 
else [الكمية] - [Sum of كمية السداد]),
    #"اضافة عمود قيمة المطلوب سداده" = Table.AddColumn(#"اضافة عمود كمية المطلوب سداده", "قيمة المطلوب سداده", each [سعر CIF متوقع]*[كمية المطلوب سداده], type number ),
    #"اضافة عمود حالة التجميع" = Table.AddColumn(#"اضافة عمود قيمة المطلوب سداده", "حالة التجميع", each if [موقف العقد] <> "FINISH" and [التصنيف] = "الصويا" then "SOYA - " & Text.From([سعر CIF متوقع])
else if [التصنيف] <> "الصويا" then [الرقم داخلي]
else "مستبعد", type text )
in #"اضافة عمود حالة التجميع"