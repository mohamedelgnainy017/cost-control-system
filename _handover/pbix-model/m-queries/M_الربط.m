let
    Source = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true){[Name="الربط"]}[Data],
    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
    #"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers",{{"الرقم الداخلي", type text}, {"تاريخ الربط", type date}, {"المورد", type text}, {"رقم العقد", type text}, {"الصنف", type text}, {"بورصة التعاقد", type date}, {"عدد العقود", Int64.Type}, {"كمية الربط", Int64.Type}, {"سعر البورصة", type number}, {"بورصة الربط", type date}, {"بريم الربط", type number}, {"سعر الربط", type number}, {"ملاحظات الربط", type text}}),
    #"Added Index" = Table.AddIndexColumn(#"Changed Type", "Index", 1, 1, Int64.Type)
in
    #"Added Index"