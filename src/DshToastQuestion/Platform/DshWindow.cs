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
    // dsh-notify:// protocol. A toast click should behave like clicking the
    // DSH tray icon: show the window if it is hidden, restore it if minimized,
    // and bring it to the front.
    // ---------------------------------------------------------------------
    const int SwShow = 5;
    const int SwRestore = 9;
    const byte VkMenu = 0x12;
    const uint KeyeventfKeyup = 0x2;

    static void FocusDsh()
    {
        try
        {
            var thread = new Thread(() =>
            {
                try
                {
                    var hwnd = FindDshWindow(includeHidden: true);
                    if (hwnd != IntPtr.Zero)
                    {
                        // Never call SW_RESTORE on a maximized window: it would
                        // un-maximize it. Only fix the state that is wrong.
                        if (IsIconic(hwnd)) ShowWindow(hwnd, SwRestore);
                        if (!IsWindowVisible(hwnd)) ShowWindow(hwnd, SwShow);
                        ForceForeground(hwnd);
                        Log(GetForegroundWindow() == hwnd ? "focus: DSH is in front" : "focus: switch not confirmed");
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

    /// <summary>
    /// Bring the window to the foreground even though the calling process does
    /// not own the foreground (a toast click is handled by the helper, not by
    /// DSH). If Windows refuses the first request, a single Alt keystroke marks
    /// the switch as user-initiated and the retry succeeds. This only runs from
    /// a toast activation, so it never fires while the user is typing.
    /// </summary>
    static void ForceForeground(IntPtr hwnd)
    {
        if (GetForegroundWindow() == hwnd) return;
        if (SetForegroundWindow(hwnd)) return;
        keybd_event(VkMenu, 0, 0, UIntPtr.Zero);
        keybd_event(VkMenu, 0, KeyeventfKeyup, UIntPtr.Zero);
        if (!SetForegroundWindow(hwnd)) Log("focus failed: foreground switch was refused");
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

    /// <summary>
    /// Find the main DSH window. The flash needs a visible window (hidden
    /// windows have no taskbar button); focus passes includeHidden so a window
    /// minimized to the tray can be shown again.
    /// </summary>
    static IntPtr FindDshWindow(bool includeHidden = false)
    {
        IntPtr exact = IntPtr.Zero;
        IntPtr fallback = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (!includeHidden && !IsWindowVisible(h)) return true;
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
