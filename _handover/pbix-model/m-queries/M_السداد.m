let
    Source = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true){[Name="السداد"]}[Data],
    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
    #"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers",{{"الرقم الداخلي", type text}, {"تاريخ السداد", type date}, {"شركة السداد", type text}, {"الصنف", type text}, {"المورد", type text}, {"رقم العقد", type text}, {"الشركة الداخلية", type text}, {"نوع السداد", type text}, {"نوع السعر", type text}, {"كمية السداد", type number}, {"سعر السداد", type number}, {"ريت السداد", type number}, {"مسئول السداد", type text}, {"ملاحظات السداد", type text}, {"موقف السداد", type text}})
in
    #"Changed Type"