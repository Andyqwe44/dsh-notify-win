namespace DshToastQuestion;

static partial class Program
{
    // ---------------------------------------------------------------------
    // Wake DSH for one answer click.
    //
    // A question is answered by the DSH page clicking its own official card —
    // the host never settles the question itself. Chromium throttles a hidden
    // window's timers, so while DSH is minimized that click can wait until the
    // user restores the window. The host therefore asks for this wake when it
    // parks an answer and no page is visible: the window is restored and raised
    // WITHOUT activation, the page clicks its card (it does that on the
    // visibility event, so the window is up for a few hundred milliseconds),
    // and the host sends `restore` to put the window back exactly as it was.
    //
    // SetWindowPlacement is used instead of ShowWindow: SW_RESTORE would take
    // the foreground and SW_MINIMIZE would activate the next window, both of
    // which would steal focus from whatever the user is doing. The placement
    // variants restore/minimize without touching activation.
    //
    // A safety timer restores the window even when no `restore` arrives (a
    // crashed page, a session switch), so a wake can never leave DSH up.
    // ---------------------------------------------------------------------
    const int SwShowMinNoActive = 7;
    static readonly IntPtr HwndBottom = new(1);
    const long WakeTimeoutMs = 15000;

    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPLACEMENT
    {
        public int Length;
        public int Flags;
        public int ShowCmd;
        public POINT MinPosition;
        public POINT MaxPosition;
        public RECT NormalPosition;
    }

    [DllImport("user32.dll")]
    static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);

    [DllImport("user32.dll")]
    static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);

    static readonly object WakeGate = new();
    static IntPtr _wakeHwnd;
    static bool _wakeWasMinimized;
    static long _wakeUntil;
    static System.Threading.Timer? _wakeTimer;
    /// <summary>Test-only: `--no-wake` keeps every window untouched.</summary>
    static bool _wakeDisabled;

    /// <summary>Show/minimize one window without ever changing the foreground.</summary>
    static bool ShowWindowInPlace(IntPtr hwnd, int showCmd)
    {
        var placement = new WINDOWPLACEMENT { Length = Marshal.SizeOf<WINDOWPLACEMENT>() };
        if (!GetWindowPlacement(hwnd, ref placement)) return false;
        placement.Length = Marshal.SizeOf<WINDOWPLACEMENT>();
        placement.ShowCmd = showCmd;
        return SetWindowPlacement(hwnd, ref placement);
    }

    /// <summary>Show DSH without taking focus, for one answer click.</summary>
    static void WakeDshForAnswer()
    {
        if (_wakeDisabled)
        {
            Log("wake suppressed: --no-wake");
            return;
        }
        lock (WakeGate)
        {
            var hwnd = _wakeHwnd != IntPtr.Zero ? _wakeHwnd : FindDshWindow();
            if (hwnd == IntPtr.Zero)
            {
                Log("wake skipped: no visible DSH window");
                return;
            }
            if (_wakeUntil == 0)
            {
                if (!IsWindowVisible(hwnd))
                {
                    // A window hidden to the tray must be shown by the app
                    // itself; forcing it open here would reveal a suspended
                    // renderer. The parked answer waits for the user instead.
                    Log("wake skipped: DSH window is hidden");
                    return;
                }
                _wakeHwnd = hwnd;
                _wakeWasMinimized = IsIconic(hwnd);
                _wakeUntil = Environment.TickCount64 + WakeTimeoutMs;
                _wakeTimer?.Dispose();
                _wakeTimer = new System.Threading.Timer(_ =>
                {
                    try { RestoreDshAfterAnswer(); }
                    catch (Exception error) { Log("wake timer failed: " + error.Message); }
                }, null, WakeTimeoutMs, Timeout.Infinite);
                Log(_wakeWasMinimized
                    ? "wake: restoring the minimized window for one click"
                    : "wake: raising the covered window for one click");
            }
            // Restore without activation, then raise without activation so the
            // renderer is un-occluded (Chromium throttles it otherwise).
            if (IsIconic(hwnd) && !ShowWindowInPlace(hwnd, SwShowNoActivate))
            {
                ShowWindow(hwnd, SwShowNoActivate);
            }
            SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0,
                SwpNomove | SwpNosize | SwpNoactivate | SwpShowWindow);
        }
    }

    /// <summary>Put the window back the way the user left it. Idempotent.</summary>
    static void RestoreDshAfterAnswer()
    {
        lock (WakeGate)
        {
            if (_wakeUntil == 0) return;
            var hwnd = _wakeHwnd;
            var minimized = _wakeWasMinimized;
            _wakeUntil = 0;
            _wakeHwnd = IntPtr.Zero;
            _wakeTimer?.Dispose();
            _wakeTimer = null;
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return;
            try
            {
                if (minimized)
                {
                    // SW_SHOWMINNOACTIVE: minimize without activating the next
                    // window, which SW_MINIMIZE would do.
                    if (!ShowWindowInPlace(hwnd, SwShowMinNoActive)) ShowWindow(hwnd, SwShowMinNoActive);
                }
                else if (GetForegroundWindow() != hwnd)
                {
                    // It was visible but covered before the wake: send it back
                    // down without touching the foreground window.
                    SetWindowPos(hwnd, HwndBottom, 0, 0, 0, 0,
                        SwpNomove | SwpNosize | SwpNoactivate);
                }
                Log("wake: window restored");
            }
            catch (Exception error)
            {
                Log("wake restore failed: " + error.Message);
            }
        }
    }
}
