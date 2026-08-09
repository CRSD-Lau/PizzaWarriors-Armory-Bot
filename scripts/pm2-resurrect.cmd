@echo off
setlocal

rem Keep PM2's saved process list under Neil's normal user profile when this
rem task runs before an interactive desktop session exists.
set "PM2_HOME=C:\Users\neil_\.pm2"
set "PATH=C:\Program Files\nodejs;C:\Users\neil_\AppData\Roaming\npm;%PATH%"

call "C:\Users\neil_\AppData\Roaming\npm\pm2.cmd" resurrect
