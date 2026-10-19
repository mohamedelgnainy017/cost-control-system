let
    Source = Excel.Workbook(File.Contents("C:\Users\Aleman\Desktop\عقود الاستيراد - 2026 - جديد.xlsm"), null, true){[Name="الارصدة"]}[Data],
    #"Promoted Headers" = Table.PromoteHeaders(Source, [PromoteAllScalars=true]),
    #"Changed Type" = Table.TransformColumnTypes(#"Promoted Headers",{{"تاريخ التقرير", type date}, {"كود الصنف", Int64.Type}, {"اسم الصـــــــنف", type text}, {"الوحدة", type text}, {" مــوقع#(lf) الـسواقي ", Int64.Type}, {" مــوقع #(lf)الــواحة ", Int64.Type}, {" مــوقع #(lf)العامرية ", Int64.Type}, {" مــوقع #(lf)الصالحية ", type number}, {"اجمالى الرصيد", Int64.Type}, {"معدل #(lf)الاستهلاك ", Currency.Type}, {"   يكفى لمدة (بالايام)", type number}, {"حتي تاريخ", type date}, {"الاستهلاك", type number}, {"اللوط", type number}, {"تعاقدات إضافات", Int64.Type}, {"ميناء إضافات", type number}}),
    #"Merged Queries" = Table.NestedJoin(#"Changed Type", {"كود الصنف"}, الاصناف, {"كود الصنف"}, "الاصناف", JoinKind.LeftOuter),
    #"Expanded الاصناف" = Table.ExpandTableColumn(#"Merged Queries", "الاصناف", {"اسم الصنف", "التوجية"}, {"التصنيف", "التوجية"})
in
    #"Expanded الاصناف"