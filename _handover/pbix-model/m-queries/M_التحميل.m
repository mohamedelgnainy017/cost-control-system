let
    Source = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true){[Name="التحميل"]}[Data],
    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
    #"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers",{{"الرقم الداخلي", type text}, {"تاريخ التحميل", type text}, {"رقم العقد", type text}, {"الصنف", type text}, {"اسم المركب", type text}, {"نوع التحميل", type text}, {"كمية التحميل", type number}, {"ملاحظات التحميل", type text}})
in
    #"Changed Type"