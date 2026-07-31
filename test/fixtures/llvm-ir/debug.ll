; ModuleID = 'source.cpp'
source_filename = "source.cpp"

define dso_local i32 @square(i32 noundef %value) !dbg !10 {
entry:
  %mul = mul nsw i32 %value, %value, !dbg !15
  ret i32 %mul, !dbg !16
}

!1 = !DIFile(filename: "source.cpp", directory: "/project")
!10 = distinct !DISubprogram(name: "square", file: !1, line: 3, scopeLine: 3)
!14 = !DILexicalBlock(scope: !10, file: !1, line: 3, column: 29)
!15 = !DILocation(line: 4, column: 12, scope: !14)
!16 = !DILocation(line: 5, column: 5, scope: !10)
