let
    Source = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true){[Name="الافراج"]}[Data],
    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
    #"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers",{{"الرقم الداخلي", type text}, {"تاريخ الافراج", type datetime}, {"رقم العقد", type text}, {"الصنف", type text}, {"اسم المركب", type text}, {"كمية الافراج", type number}})
in
    #"Changed Type"