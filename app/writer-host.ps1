param([string]$WriterExe,[int]$WriterParentId,[string]$WriterLog)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WriterJob {
 [StructLayout(LayoutKind.Sequential)] public struct Basic { public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] public struct IO { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] public struct Limits { public Basic Basic; public IO IO; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job,int type,ref Limits limits,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$writerParent=[Diagnostics.Process]::GetProcessById($WriterParentId)
$writerJob=[WriterJob]::CreateJobObject([IntPtr]::Zero,$null)
$writerLimits=New-Object WriterJob+Limits
$writerBasic=New-Object WriterJob+Basic
$writerBasic.Flags=0x2000
$writerLimits.Basic=$writerBasic
if(!$writerJob -or ![WriterJob]::SetInformationJobObject($writerJob,9,[ref]$writerLimits,[Runtime.InteropServices.Marshal]::SizeOf($writerLimits))){throw 'Cannot contain the story writer process.'}
try {
 $writerProcess=Start-Process -FilePath $WriterExe -ArgumentList 'serve' -WindowStyle Hidden -PassThru -RedirectStandardOutput ($WriterLog+'.stdout.log') -RedirectStandardError ($WriterLog+'.stderr.log')
 if(![WriterJob]::AssignProcessToJobObject($writerJob,$writerProcess.Handle)){$writerProcess.Kill();throw 'Cannot contain the story writer process tree.'}
 @{pid=$writerProcess.Id;parent=$WriterParentId;guard=$PID;killOnClose=($writerLimits.Basic.Flags -eq 0x2000)}|ConvertTo-Json|Set-Content -LiteralPath ($WriterLog+'.host.json')
 while(!$writerProcess.HasExited){if($writerParent.WaitForExit(250) -or (Test-Path -LiteralPath ($WriterLog+'.stop'))){break}}
} finally {
 [void][WriterJob]::CloseHandle($writerJob)
 if($writerProcess){[void]$writerProcess.WaitForExit(5000);$writerProcess.Dispose()}
 $writerParent.Dispose()
}
