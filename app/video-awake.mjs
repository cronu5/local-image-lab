import {spawn} from 'node:child_process';

// A process-scoped Windows request; the screen may sleep and no power plan is changed.
export function holdAwake() {
  if(process.platform!=='win32') return ()=>{};
  const script=`$ErrorActionPreference='Stop'; Add-Type -Name SleepGuard -Namespace LocalImageLab -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; $parentProcess=[System.Diagnostics.Process]::GetProcessById(${process.pid}); if([LocalImageLab.SleepGuard]::SetThreadExecutionState(2147483649) -eq 0){exit 1}; Write-Output 'awake'; while(-not $parentProcess.WaitForExit(30000)){[void][LocalImageLab.SleepGuard]::SetThreadExecutionState(2147483649)}`;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  const release=()=>child.kill();
  release.ready=new Promise(resolve=>{child.stdout.on('data',b=>{if(b.toString().includes('awake'))resolve(true);});child.on('error',()=>resolve(false));child.on('close',()=>resolve(false));});
  return release;
}
