墨迹 · 便携版
=============

不用安装：整个文件夹拷到哪儿都行（U 盘也可以），双击 MoJi.exe 就能用。
不写注册表，不在系统里留东西，卸载就等于删掉这个文件夹。


数据在哪
--------
就在这个文件夹里：data\moji.sqlite3
抄写进度、练习统计、设置全在里面 —— 文件夹拷走，数据跟着走。

  · 别删 data 目录，也别改名：软件靠它认出"这一份是便携版"。
  · 没有 data 目录的话，数据会写到 C:\Users\<你>\AppData\Local\MoJi\，
    和安装版共用一份。


第一次启动
----------
Windows 10 / 11 自带 WebView2 运行时，直接就能跑。
万一提示缺少 WebView2，装一下微软的 Evergreen Runtime（免费）：

    https://developer.microsoft.com/microsoft-edge/webview2/


把旧数据搬过来
--------------
如果之前用的是安装版，把

    %LOCALAPPDATA%\MoJi\moji.sqlite3

复制到这里的 data\ 目录下即可（覆盖同名文件）。也可以打开软件，
在「设置 → 导出备份 / 导入备份」里搬。


快捷键
------
Tab            下一章
Ctrl + Enter   完成本章
Esc            退出专注模式
