let
    Source = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true){[Name="بيع_خارجى"]}[Data],
    #"Changed Type" = Table.TransformColumnTypes(Source,{{"الرقم الداخلي", type text}, {"تاريخ البيع", type datetime}, {"رقم العقد", type text}, {"الصنف", type text}, {"اسم المركب", type text}, {"كمية المبيعات", Int64.Type}})
in
    #"Changed Type"