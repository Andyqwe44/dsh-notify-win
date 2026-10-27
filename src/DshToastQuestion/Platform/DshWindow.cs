namespace DshToastQuestion;

static partial class Program
{
    /// <summary>Whether DSH is already the foreground window.</summary>
    static bool TestDshWindowFocused() => IsDshWindow(GetForegroundWindow());

    /// <summary>Whether the window belongs to DSH, judged by its title.</summary>
    static bool IsDshWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        try
        {
            var sb = new StringBuilder(512);
            GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString().Contains(BrandName, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    // ---------------------------------------------------------------------
    // Focus / launch DSH. The resident helper handles Activated in-process;
    // --focus covers a click on a toast after DSH/helper restarted, and the
    // dsh-notify:// protocol.
    // ---------------------------------------------------------------------
    static void FocusDsh()
    {
        try
        {
            var thread = new Thread(() =>
            {
                try
                {
                    var hwnd = FindDshWindow();
                    if (hwnd != IntPtr.Zero)
                    {
                        ShowWindow(hwnd, 9); // SW_RESTORE
                        SetForegroundWindow(hwnd);
                        return;
                    }
                    if (!LaunchDshApp()) Log("focus failed: DSH window and app not found");
                }
                catch (Exception error)
                {
                    Log("focus failed: " + error.Message);
                }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.IsBackground = true;
            thread.Start();
            thread.Join(3000);
        }
        catch (Exception error)
        {
            Log("focus thread failed: " + error.Message);
        }
    }

    static bool LaunchDshApp()
    {
        var shellType = Type.GetTypeFromProgID("Shell.Application");
        if (shellType == null) return false;
        dynamic shell = Activator.CreateInstance(shellType)!;
        object? folder = shell.NameSpace("shell:AppsFolder");
        if (folder == null) return false;
        dynamic items = ((dynamic)folder).Items();
        int count = (int)items.Count;
        for (int i = 0; i < count; i++)
        {
            dynamic item = items.Item(i);
            string name = (string?)item.Name ?? "";
            string path = (string?)item.Path ?? "";
            if (!name.Equals(BrandName, StringComparison.OrdinalIgnoreCase)) continue;
            if (!path.Contains("!App", StringComparison.OrdinalIgnoreCase)) continue;
            Process.Start(new ProcessStartInfo("explorer.exe", $"shell:AppsFolder\\{path}")
            {
                UseShellExecute = true,
            });
            Log("launched DSH app: " + path);
            return true;
        }
        return false;
    }

    static IntPtr FindDshWindow()
    {
        IntPtr exact = IntPtr.Zero;
        IntPtr fallback = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, sb.Capacity);
            string title = sb.ToString();
            if (title.Contains("— DeepSeek Harness", StringComparison.OrdinalIgnoreCase))
            {
                exact = h;
                return false;
            }
            if (title.Contains(BrandName, StringComparison.OrdinalIgnoreCase)) fallback = h;
            return true;
        }, IntPtr.Zero);
        return exact != IntPtr.Zero ? exact : fallback;
    }
}
