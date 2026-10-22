let
    Source = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true){[Name="الرولينج"]}[Data],
    #"Changed Type" = Table.TransformColumnTypes(Source,{{"الرقم الداخلي", type text}, {"تاريخ الترويل", type datetime}, {"رقم العقد", type any}, {"المورد", type text}, {"الصنف", type text}, {"كمية الترويل", type number}, {"بورصة التعاقد", type date}, {"بورصة الربط", type date}, {"بورصة سابقة", type date}, {"بورصة الرولينج", type date}, {"سعر الرولينج", type number}, {"ملاحظات الرولينج", type any}})
in
    #"Changed Type"