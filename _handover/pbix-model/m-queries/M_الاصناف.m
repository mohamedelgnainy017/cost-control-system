let
    Source = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true){[Name="الاصناف"]}[Data],
    #"Changed Type" = Table.TransformColumnTypes(Source,{{"كود الصنف", Int64.Type}, {"اسم الصنف", type text}, {"التوجية", type text}})
in
    #"Changed Type"