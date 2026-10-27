namespace DshToastQuestion;

static partial class Program
{
    /// <summary>Start the shell-owned "until DSH is foreground" flash.</summary>
    static void FlashTaskbar()
    {
        try
        {
            var hwnd = FindDshWindow();
            // If DSH is already in front there is nothing to attract; arming a
            // flash here would only surface later, after the user leaves.
            if (hwnd == IntPtr.Zero || GetForegroundWindow() == hwnd) return;
            var info = new FLASHWINFO
            {
                cbSize = (uint)Marshal.SizeOf<FLASHWINFO>(),
                hwnd = hwnd,
                dwFlags = FlashTray | FlashTimerNoForeground, // 2 | 12
                uCount = 0,    // ignored by TIMERNOFG: the shell decides the count
                dwTimeout = 0, // system caret blink rate
            };
            FlashWindowEx(ref info);
        }
        catch
        {
            // Best-effort: flashing must never break the toast flow.
        }
    }

    /// <summary>Stop an active flash and restore the button's normal state.</summary>
    static void StopTaskbarFlash()
    {
        try
        {
            var hwnd = FindDshWindow();
            if (hwnd == IntPtr.Zero) return;
            var info = new FLASHWINFO
            {
                cbSize = (uint)Marshal.SizeOf<FLASHWINFO>(),
                hwnd = hwnd,
                dwFlags = FlashStop, // 0: stop and restore the original state
                uCount = 0,
                dwTimeout = 0,
            };
            FlashWindowEx(ref info);
        }
        catch
        {
            // Best-effort: a hot reload must not fail because the window is gone.
        }
    }
}
