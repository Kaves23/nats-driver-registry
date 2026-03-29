@echo off
set CSC=C:\Windows\Microsoft.NET\Framework\v3.5\csc.exe
set CF=C:\Program Files (x86)\Microsoft.NET\SDK\CompactFramework\v3.5\WindowsCE
set WM=C:\Program Files (x86)\Windows Mobile 6 SDK\Managed Libraries
set OUT=bin\WM_Release

if not exist %OUT% mkdir %OUT%

echo Building ROKControl for Windows Mobile...

"%CSC%" ^
  /noconfig /nostdlib /target:winexe /optimize ^
  /out:"%OUT%\ROKControl.exe" ^
  /define:WM_DEVICE ^
  /r:"%CF%\mscorlib.dll" ^
  /r:"%CF%\System.dll" ^
  /r:"%CF%\System.Windows.Forms.dll" ^
  /r:"%CF%\System.Drawing.dll" ^
  /r:"%CF%\System.Data.dll" ^
  /r:"%CF%\System.Xml.dll" ^
  /r:"%WM%\Microsoft.WindowsMobile.dll" ^
  /r:"%WM%\Microsoft.WindowsMobile.Status.dll" ^
  AppConfig.cs ^
  DataStore.cs ^
  FormMain.cs ^
  FormMain.Designer.cs ^
  FormConfig.cs ^
  FormConfig.Designer.cs ^
  FormDriverLookup.cs ^
  FormDriverLookup.Designer.cs ^
  FormEventPicker.cs ^
  FormEventPicker.Designer.cs ^
  Program.cs ^
  ScannerHelper.cs ^
  ServerSync.cs ^
  Properties\AssemblyInfo.cs

if %ERRORLEVEL%==0 (
  echo.
  echo *** BUILD SUCCEEDED ***
  echo Output: %OUT%\ROKControl.exe
  echo.
  echo Next steps:
  echo  1. Connect scanner via USB - Windows Mobile Device Center opens
  echo  2. Click "File Management" then "Browse device contents"
  echo  3. Navigate to My Device\Program Files\
  echo  4. Create folder ROKControl
  echo  5. Copy bin\WM_Release\ROKControl.exe into it
  echo  6. On device: tap ROKControl.exe to run
) else (
  echo.
  echo *** BUILD FAILED - see errors above ***
)

pause
