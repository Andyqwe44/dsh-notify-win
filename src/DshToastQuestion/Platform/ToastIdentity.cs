namespace DshToastQuestion;

static partial class Program
{
    static string AssetPath(string leaf) => Path.Combine(AppContext.BaseDirectory, leaf);

    // ---------------------------------------------------------------------
    // One-time OS registration: branded toast identity (AUMID + Start Menu
    // shortcut) and the dsh-notify:// protocol pointing at --focus. The helper
    // no longer depends on any PowerShell script to be branded or clickable.
    // ---------------------------------------------------------------------
    static void EnsureToastIdentity()
    {
        string exe = Environment.ProcessPath
            ?? Path.Combine(AppContext.BaseDirectory, "dsh-toast-question.exe");
        using var key = Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelID\{Aumid}");
        if (key == null) return;
        key.SetValue("DisplayName", BrandName);
        string lightIcon = AssetPath("dsh-logo-light.png");
        if (File.Exists(lightIcon)) key.SetValue("IconUri", lightIcon);

        string ico = AssetPath("dsh-logo.ico");
        string lnk = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            @"Microsoft\Windows\Start Menu\Programs",
            ShortcutFileName);
        bool registered = string.Equals(key.GetValue("ShortcutRegistered") as string, "1", StringComparison.Ordinal);
        if (registered && File.Exists(lnk) && ShortcutTargets(lnk, exe)) return;
        if (!File.Exists(ico) || !File.Exists(exe)) return;

        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) return;
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic shortcut = shell.CreateShortcut(lnk);
        shortcut.TargetPath = exe;
        shortcut.Arguments = "";
        shortcut.IconLocation = ico + ",0";
        shortcut.Description = "DeepSeek Harness notifications";
        shortcut.WindowStyle = 7;
        shortcut.Save();

        bool aumidOk = false;
        for (int attempt = 0; attempt < 3 && !aumidOk; attempt++)
        {
            try
            {
                SetShortcutAumid(lnk, Aumid);
                aumidOk = true;
            }
            catch (Exception error)
            {
                Log("shortcut AUMID attempt " + (attempt + 1) + " failed: " + error.Message);
                Thread.Sleep(400);
            }
        }
        if (aumidOk) key.SetValue("ShortcutRegistered", "1");
        Log("toast identity registered: " + lnk);
    }

    static bool ShortcutTargets(string lnkPath, string expected)
    {
        try
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return false;
            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic shortcut = shell.CreateShortcut(lnkPath);
            string? target = shortcut.TargetPath as string;
            return string.Equals(target, expected, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    static void EnsureDshProtocol()
    {
        string exe = Environment.ProcessPath
            ?? Path.Combine(AppContext.BaseDirectory, "dsh-toast-question.exe");
        using var key = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProtocolName}");
        if (key == null) return;
        key.SetValue("", "URL:dsh-notify Protocol");
        key.SetValue("URL Protocol", "");
        using var command = key.CreateSubKey(@"shell\open\command");
        if (command == null) return;
        command.SetValue("", $"\"{exe}\" --focus \"%1\"");
    }

    static void SetShortcutAumid(string lnkPath, string appId)
    {
        var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out IntPtr ppv);
        if (hr != 0) throw new COMException("property store open failed: 0x" + hr.ToString("X8"), hr);
        var props = (IPropertyStore)Marshal.GetObjectForIUnknown(ppv);
        try
        {
            var key = new PROPERTYKEY
            {
                fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
                pid = 5,
            };
            var value = new PROPVARIANT
            {
                vt = 31, // VT_LPWSTR
                pwszVal = Marshal.StringToCoTaskMemUni(appId),
            };
            try
            {
                hr = props.SetValue(ref key, ref value);
                if (hr != 0) throw new COMException("SetValue failed: 0x" + hr.ToString("X8"), hr);
                hr = props.Commit();
                if (hr != 0) throw new COMException("Commit failed: 0x" + hr.ToString("X8"), hr);
            }
            finally
            {
                Marshal.FreeCoTaskMem(value.pwszVal);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(props);
            Marshal.Release(ppv);
        }
    }
}
