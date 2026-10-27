namespace DshToastQuestion;

static partial class Program
{
    // The flash is shell-owned: FLASHW_TRAY | FLASHW_TIMERNOFG makes Explorer
    // flash the taskbar button until the DSH window is in the foreground.
    // Explorer only notices that on its next flash tick and the button then
    // fades out, which feels like a delay. We therefore remember the target
    // window and issue FLASHW_STOP ourselves as soon as a DSH window comes to
    // the foreground. That also stops the flash when the activated window is
    // not the one that was armed (for example a different DSH top-level window).
    static readonly object FlashLock = new();
    static readonly WinEventProc ForegroundHook = OnForegroundChanged;
    static IntPtr _flashHwnd;
    static IntPtr _foregroundHook;
    static Thread? _flashWatcher;

    /// <summary>Arm the shell flash and the foreground watcher.</summary>
    static void FlashTaskbar()
    {
        try
        {
            var hwnd = FindDshWindow();
            // If DSH is already in front there is nothing to attract; arming a
            // flash here would only surface later, after the user leaves.
            if (hwnd == IntPtr.Zero || TestDshWindowFocused()) return;

            lock (FlashLock) _flashHwnd = hwnd;
            EnsureFlashWatcher();

            var info = new FLASHWINFO
            {
                cbSize = (uint)Marshal.SizeOf<FLASHWINFO>(),
                hwnd = hwnd,
                dwFlags = FlashTray | FlashTimerNoForeground, // 2 | 12
                uCount = 0,    // ignored by TIMERNOFG: the shell decides the count
                dwTimeout = 0, // system caret blink rate
            };
            FlashWindowEx(ref info);
            Log("flash armed");
        }
        catch
        {
            // Best-effort: flashing must never break the toast flow.
        }
    }

    /// <summary>Stop an active flash and restore the button's normal state.</summary>
    static void StopTaskbarFlash()
    {
        IntPtr hwnd;
        lock (FlashLock)
        {
            hwnd = _flashHwnd;
            _flashHwnd = IntPtr.Zero;
        }
        // No armed flash but a stop was requested anyway (helper reloaded while
        // the previous instance was flashing): clear the window we find.
        if (hwnd == IntPtr.Zero) hwnd = FindDshWindow();
        if (hwnd == IntPtr.Zero) return;
        try
        {
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

    static IntPtr ArmedFlashWindow()
    {
        lock (FlashLock) return _flashHwnd;
    }

    static void EnsureFlashWatcher()
    {
        if (_flashWatcher != null) return;
        lock (FlashLock)
        {
            if (_flashWatcher != null) return;
            _flashWatcher = new Thread(WatchForeground)
            {
                IsBackground = true,
                Name = "dsh-foreground-watch",
            };
            _flashWatcher.Start();
        }
    }

    /// <summary>
    /// Owns the WinEvent hook that stops the flash the moment a DSH window is
    /// foreground, instead of waiting for Explorer's next flash tick. The hook
    /// needs a message loop, so this thread pumps one and otherwise sleeps.
    /// </summary>
    static void WatchForeground()
    {
        try
        {
            // Create this thread's message queue before installing the hook so
            // no early foreground event can be dropped.
            PeekMessage(out _, IntPtr.Zero, 0, 0, 0);
            _foregroundHook = SetWinEventHook(
                EventSystemForeground, EventSystemForeground,
                IntPtr.Zero, ForegroundHook, 0, 0, WineventOutOfContext);
            if (_foregroundHook == IntPtr.Zero)
            {
                Log("foreground hook failed");
                lock (FlashLock) _flashWatcher = null; // allow a retry on the next flash
                return;
            }
            // The flash may have been armed while this thread was starting.
            if (ArmedFlashWindow() != IntPtr.Zero && TestDshWindowFocused()) StopTaskbarFlash();
            MSG message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
            UnhookWinEvent(_foregroundHook);
        }
        catch (Exception error)
        {
            Log("foreground watcher failed: " + error.Message);
            lock (FlashLock) _flashWatcher = null;
        }
    }

    static void OnForegroundChanged(IntPtr hook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint idEventThread, uint msEventTime)
    {
        try
        {
            if (idObject != 0) return; // OBJID_WINDOW only
            var armed = ArmedFlashWindow();
            if (armed == IntPtr.Zero) return;
            if (hwnd == armed || IsDshWindow(hwnd))
            {
                Log("flash stopped: DSH is foreground");
                StopTaskbarFlash();
            }
        }
        catch
        {
            // A hook callback must never throw across the native boundary.
        }
    }
}
