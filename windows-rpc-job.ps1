$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class PiWebRpcJob
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedStartupInfo
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute,
        IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
        string cwd, ref ExtendedStartupInfo startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    static void Check(bool success)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    public static int Run(uint ownerPid, string executable, string[] args, string cwd)
    {
        IntPtr owner = OpenProcess(0x00100000, false, ownerPid);
        if (owner == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr job = IntPtr.Zero;
        var child = new ProcessInformation();
        IntPtr attributes = IntPtr.Zero, jobValue = IntPtr.Zero;
        bool attributesInitialized = false;
        try
        {
            // Acquire the owner's handle before launching, so PID reuse cannot keep this job alive.
            if (WaitForSingleObject(owner, 0) != 258) return 1;
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            var limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
            attributesInitialized = true;
            jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobValue, job);
            Check(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x0002000D),
                jobValue, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero)); // PROC_THREAD_ATTRIBUTE_JOB_LIST
            var startup = new ExtendedStartupInfo();
            startup.AttributeList = attributes;
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(startup);
            startup.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
            startup.StartupInfo.hStdInput = GetStdHandle(-10);
            startup.StartupInfo.hStdOutput = GetStdHandle(-11);
            startup.StartupInfo.hStdError = GetStdHandle(-12);
            foreach (IntPtr handle in new[] { startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError })
                Check(SetHandleInformation(handle, 1, 1));
            var commandLine = new StringBuilder(Quote(executable));
            foreach (string arg in args) commandLine.Append(' ').Append(Quote(arg));
            // Atomic job assignment also covers the launcher dying during process creation.
            Check(CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                0x08080004, IntPtr.Zero, cwd, ref startup, out child)); // NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | SUSPENDED
            Check(ResumeThread(child.hThread) != UInt32.MaxValue);
            uint completed = WaitForMultipleObjects(2, new[] { owner, child.hProcess }, false, UInt32.MaxValue);
            Check(completed != UInt32.MaxValue);
            uint code = 1;
            if (completed == 1) Check(GetExitCodeProcess(child.hProcess, out code));
            return unchecked((int)code);
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            CloseHandle(owner);
        }
    }
}
'@

try {
    $launch = $env:PI_WEB_RPC_JOB | ConvertFrom-Json
    Remove-Item Env:PI_WEB_RPC_JOB
    $code = [PiWebRpcJob]::Run([uint32]$launch.ownerPid, [string]$launch.executable, [string[]]$launch.args, [string]$launch.cwd)
    exit $code
} catch {
    [Console]::Error.WriteLine("pi-web RPC job failed: " + $_.Exception.Message)
    exit 1
}
