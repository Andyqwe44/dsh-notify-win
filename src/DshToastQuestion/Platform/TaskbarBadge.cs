namespace DshToastQuestion;

/// <summary>
/// QQ-style unread badge on DSH's own taskbar button.
///
/// The tray icon belongs to the Electron main process and cannot be animated
/// from another process, so the reminder is drawn where the user already
/// looks: an `ITaskbarList3` overlay on the DSH window — the small red dot at
/// the button's bottom-right corner. It blinks until a DSH window is
/// foreground, the host retires it, or the configured limit expires. No extra
/// notification icon, no second process, and nothing to pin in the tray.
///
/// A window hidden to the tray has no taskbar button, so the badge waits for
/// DSH to be visible instead of pretending to attract attention; the toast (or
/// the Action Center entry it leaves behind) carries that case.
/// </summary>
static partial class Program
{
    const int BadgeTickMs = 100;
    const uint CoinitApartmentThreaded = 0x2;

    static readonly object BadgeLock = new();
    static volatile bool _badgeRequested;
    static volatile bool _badgeExit;
    static string _badgeReason = "";
    static long _badgeStartedAt;
    static long _badgeToggledAt;
    static bool _badgeFrameOn;
    static Thread? _badgeThread;
    static bool _badgeNoWindowLogged;

    /// <summary>Arm (or refresh) the taskbar badge blink; safe from any thread.</summary>
    static void StartTaskbarBadge(string reason, int intervalMs, int maxMinutes)
    {
        lock (BadgeLock)
        {
            _blinkIntervalMs = Math.Clamp(intervalMs, 200, 5000);
            _blinkMaxMinutes = Math.Max(0, maxMinutes);
            _badgeReason = string.IsNullOrEmpty(reason) ? "有新的通知" : reason;
            if (!_badgeRequested)
            {
                _badgeRequested = true;
                _badgeStartedAt = Environment.TickCount64;
                _badgeToggledAt = _badgeStartedAt;
                _badgeFrameOn = false;
            }
        }
        EnsureBadgeThread();
        // The same foreground hook that stops the taskbar flash retires the
        // badge the moment a DSH window is activated.
        EnsureFlashWatcher();
        Log("taskbar badge armed: " + _badgeReason + " interval=" + _blinkIntervalMs + " max=" + _blinkMaxMinutes);
    }

    /// <summary>Stop blinking; the badge thread clears the overlay on its next tick.</summary>
    static void StopTaskbarBadge()
    {
        lock (BadgeLock) _badgeRequested = false;
    }

    static bool BadgeBlinking()
    {
        lock (BadgeLock) return _badgeRequested;
    }

    /// <summary>
    /// Clear the overlay synchronously before the helper exits. The badge lives
    /// on DSH's window, not on this process, so a blink abandoned at shutdown
    /// would outlive the helper as a stale red dot.
    /// </summary>
    static void DisposeTaskbarBadge()
    {
        StopTaskbarBadge();
        _badgeExit = true;
        var thread = _badgeThread;
        if (thread != null) thread.Join(600);
    }

    /// <summary>
    /// Clear a badge left behind by a helper that was killed mid-blink. The
    /// overlay lives on DSH's window, so a crash (no graceful Dispose) would
    /// otherwise keep a stale red dot on the taskbar button until DSH exits.
    /// Runs once at startup on its own short-lived STA thread.
    /// </summary>
    static void ClearStaleTaskbarBadge()
    {
        var thread = new Thread(() =>
        {
            var coInit = -1;
            try
            {
                coInit = CoInitializeEx(IntPtr.Zero, CoinitApartmentThreaded);
                var hwnd = FindDshWindow();
                var clsid = hwnd == IntPtr.Zero ? null : Type.GetTypeFromCLSID(TaskbarList.Clsid);
                if (clsid != null && Activator.CreateInstance(clsid) is ITaskbarList3 list)
                {
                    list.HrInit();
                    list.SetOverlayIcon(hwnd, IntPtr.Zero, "");
                    Log("stale taskbar badge cleared");
                }
            }
            catch (Exception error)
            {
                Log("stale taskbar badge clear failed: " + error.Message);
            }
            finally
            {
                if (coInit >= 0) CoUninitialize();
            }
        })
        {
            IsBackground = true,
            Name = "dsh-taskbar-badge-reset",
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    /// <summary>Start the badge thread once (idempotent, any thread).</summary>
    static void EnsureBadgeThread()
    {
        Thread? thread;
        lock (BadgeLock)
        {
            if (_badgeThread != null) return;
            thread = new Thread(BadgeThreadMain)
            {
                IsBackground = true,
                Name = "dsh-taskbar-badge",
            };
            thread.SetApartmentState(ApartmentState.STA);
            _badgeThread = thread;
        }
        thread.Start();
    }

    /// <summary>
    /// Owns the COM object and the overlay for the helper lifetime. The shell
    /// requires the badge calls to come from the apartment that created them,
    /// so this thread is the only caller.
    /// </summary>
    static void BadgeThreadMain()
    {
        ITaskbarList3? list = null;
        IntPtr icon = IntPtr.Zero;
        IntPtr target = IntPtr.Zero;
        bool shown = false;
        int coInit = -1;
        try
        {
            coInit = CoInitializeEx(IntPtr.Zero, CoinitApartmentThreaded);
            var clsid = Type.GetTypeFromCLSID(TaskbarList.Clsid);
            list = clsid == null ? null : Activator.CreateInstance(clsid) as ITaskbarList3;
            if (list == null)
            {
                Log("taskbar badge unavailable: ITaskbarList3 not created");
                return;
            }
            list.HrInit();
            icon = CreateBadgeIcon();
            Log("taskbar badge thread ready");

            while (!_badgeExit && !_stopping)
            {
                bool requested;
                long startedAt;
                lock (BadgeLock)
                {
                    requested = _badgeRequested;
                    startedAt = _badgeStartedAt;
                }

                if (requested)
                {
                    var expired = _blinkMaxMinutes > 0 &&
                        Environment.TickCount64 - startedAt >= _blinkMaxMinutes * 60_000L;
                    if (expired || TestDshWindowFocused())
                    {
                        lock (BadgeLock) _badgeRequested = false;
                        requested = false;
                        Log(expired ? "taskbar badge stopped: timed out" : "taskbar badge stopped: DSH is foreground");
                    }
                }

                var hwnd = FindDshWindow();
                if (hwnd != target)
                {
                    if (target != IntPtr.Zero && shown) ClearOverlay(list, target);
                    target = hwnd;
                    shown = false;
                }

                if (!requested)
                {
                    if (shown && target != IntPtr.Zero)
                    {
                        ClearOverlay(list, target);
                        shown = false;
                        Log("taskbar badge cleared");
                    }
                    Thread.Sleep(BadgeTickMs);
                    continue;
                }

                if (target == IntPtr.Zero)
                {
                    if (!_badgeNoWindowLogged)
                    {
                        _badgeNoWindowLogged = true;
                        Log("taskbar badge waiting: no visible DSH window");
                    }
                    Thread.Sleep(BadgeTickMs);
                    continue;
                }
                _badgeNoWindowLogged = false;

                var now = Environment.TickCount64;
                if (now - _badgeToggledAt >= _blinkIntervalMs)
                {
                    _badgeToggledAt = now;
                    _badgeFrameOn = !_badgeFrameOn;
                    shown = _badgeFrameOn;
                    SetOverlay(list, target, shown ? icon : IntPtr.Zero,
                        shown ? Shorten(BrandName + " · " + _badgeReason, 64) : "");
                }
                Thread.Sleep(BadgeTickMs);
            }
        }
        catch (Exception error)
        {
            Log("taskbar badge failed: " + error.Message);
        }
        finally
        {
            try
            {
                if (list != null && target != IntPtr.Zero && shown) ClearOverlay(list, target);
            }
            catch { }
            if (icon != IntPtr.Zero) DestroyIcon(icon);
            if (coInit >= 0) CoUninitialize();
            lock (BadgeLock) _badgeThread = null;
            Log("taskbar badge thread exit");
        }
    }

    static void SetOverlay(ITaskbarList3 list, IntPtr hwnd, IntPtr icon, string description)
    {
        try { list.SetOverlayIcon(hwnd, icon, description); }
        catch (Exception error) { Log("taskbar badge overlay failed: " + error.Message); }
    }

    static void ClearOverlay(ITaskbarList3 list, IntPtr hwnd)
    {
        SetOverlay(list, hwnd, IntPtr.Zero, "");
    }

    /// <summary>Apply one `config` op from the host.</summary>
    static void ApplyAttentionConfig(InboundMessage message)
    {
        if (message.BlinkIntervalMs is int interval)
        {
            _blinkIntervalMs = Math.Clamp(interval, 200, 5000);
        }
        if (message.BlinkMaxMinutes is int minutes)
        {
            _blinkMaxMinutes = Math.Max(0, minutes);
        }
        Log("attention config: interval=" + _blinkIntervalMs + " maxMinutes=" + _blinkMaxMinutes);
    }

    /// <summary>
    /// Draw the badge: a red disc with a white ring so it stays readable on
    /// both light and dark taskbars. Drawn at 32 px because the shell scales
    /// the overlay for the display DPI (175% here renders it at ~28 px).
    /// </summary>
    static IntPtr CreateBadgeIcon()
    {
        try
        {
            const int size = 32;
            using var bitmap = new Bitmap(size, size);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                using var ring = new SolidBrush(Color.White);
                using var red = new SolidBrush(Color.FromArgb(235, 64, 52));
                graphics.FillEllipse(ring, 1, 1, size - 2, size - 2);
                graphics.FillEllipse(red, 4, 4, size - 8, size - 8);
            }
            // The HICON is returned to the shell, which copies it; this thread
            // keeps it for the helper lifetime and destroys it on exit.
            return bitmap.GetHicon();
        }
        catch (Exception error)
        {
            Log("taskbar badge icon failed: " + error.Message);
            return IntPtr.Zero;
        }
    }
}
