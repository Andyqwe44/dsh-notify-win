namespace DshToastQuestion;

/// <summary>
/// QQ-style red dot drawn on top of DSH's own notification-area icon.
///
/// The tray icon belongs to the Electron main process. Replacing its bitmap
/// from another process (`Shell_NotifyIcon` with a foreign window) is
/// undocumented and can leave the icon broken, so nothing about the icon is
/// touched here: a small layered window with the dot is placed over the icon's
/// cell instead. The cell comes from the documented
/// `Shell_NotifyIconGetRect`, the window is `WS_EX_TRANSPARENT` (clicks pass
/// through) and `WS_EX_NOACTIVATE` (it never steals focus), and because the
/// window belongs to this process it disappears the moment the helper dies.
///
/// Everything is event-driven: the only timer is the blink interval itself
/// (600 ms by default), and each "on" frame re-reads the icon cell with one
/// shell call that uses a cached window/id. Idle cost is a blocked message
/// loop; there is no polling thread.
/// </summary>
static partial class Program
{
    const int BlinkTimerId = 1;
    const int ExpiryTimerId = 2;
    const string OverlayClassName = "DshTrayBadgeOverlay";

    // WM_APP + n: state changes posted from any thread to the badge window.
    const uint WmAppArm = 0x8001;
    const uint WmAppStop = 0x8002;
    const uint WmDisplayChange = 0x007E;
    const uint WmSettingChange = 0x001A;

    static readonly object OverlayLock = new();
    static volatile bool _overlayRequested;
    static volatile bool _overlayIgnoreFocus;
    static string _overlayReason = "";
    static long _overlayStartedAt;
    static bool _overlayOn;
    static Thread? _overlayThread;
    static IntPtr _overlayWindow;
    static WndProc? _overlayProc;
    static IntPtr _dibDc;
    static IntPtr _dib;
    static IntPtr _dibPrevious;
    static IntPtr _dibBits;
    static int _dotSize;
    static int _dotX = int.MinValue;
    static int _dotY = int.MinValue;
    static IntPtr _trayHost;
    static uint _trayUid;
    static int _trayMisses;

    /// <summary>Arm the tray badge; false when DSH's tray icon cannot be located.</summary>
    static bool StartTrayBadge(string reason, int intervalMs, int maxMinutes)
    {
        if (!TryQueryTrayRect(out _))
        {
            Log("tray badge unavailable: DSH tray icon is not in the visible notification area");
            return false;
        }
        lock (OverlayLock)
        {
            _blinkIntervalMs = Math.Clamp(intervalMs, 200, 5000);
            _blinkMaxMinutes = Math.Max(0, maxMinutes);
            _overlayReason = string.IsNullOrEmpty(reason) ? "有新的通知" : reason;
            _overlayRequested = true;
            _overlayStartedAt = Environment.TickCount64;
            _trayMisses = 0;
        }
        EnsureOverlayThread();
        // The same foreground hook that stops the taskbar flash retires the dot
        // the moment a DSH window is activated.
        EnsureFlashWatcher();
        var window = _overlayWindow;
        if (window != IntPtr.Zero) PostMessage(window, WmAppArm, IntPtr.Zero, IntPtr.Zero);
        Log("tray badge armed: " + _overlayReason + " interval=" + _blinkIntervalMs + " max=" + _blinkMaxMinutes);
        return true;
    }

    /// <summary>Stop blinking; the badge window hides the dot on its next message.</summary>
    static void StopTrayBadge()
    {
        lock (OverlayLock) _overlayRequested = false;
        var window = _overlayWindow;
        if (window != IntPtr.Zero) PostMessage(window, WmAppStop, IntPtr.Zero, IntPtr.Zero);
    }

    static bool TrayBadgeBlinking()
    {
        lock (OverlayLock) return _overlayRequested;
    }

    /// <summary>Hide the dot synchronously before the helper exits.</summary>
    static void DisposeTrayBadge()
    {
        StopTrayBadge();
        var thread = _overlayThread;
        if (thread != null) thread.Join(400);
    }

    static void EnsureOverlayThread()
    {
        Thread? thread;
        lock (OverlayLock)
        {
            if (_overlayThread != null) return;
            thread = new Thread(OverlayThreadMain)
            {
                IsBackground = true,
                Name = "dsh-tray-badge",
            };
            thread.SetApartmentState(ApartmentState.STA);
            _overlayThread = thread;
        }
        thread.Start();
    }

    /// <summary>Owns the layered window and its message loop for the helper lifetime.</summary>
    static void OverlayThreadMain()
    {
        try
        {
            _overlayProc = OverlayWindowProc;
            var windowClass = new WNDCLASSEX
            {
                cbSize = (uint)Marshal.SizeOf<WNDCLASSEX>(),
                lpfnWndProc = _overlayProc,
                hInstance = GetModuleHandle(null),
                lpszClassName = OverlayClassName,
            };
            if (RegisterClassEx(ref windowClass) == 0)
            {
                Log("tray badge class registration failed: " + Marshal.GetLastWin32Error());
                return;
            }
            var window = CreateWindowEx(
                WsExLayered | WsExTransparent | WsExTopmost | WsExToolWindow | WsExNoActivate,
                OverlayClassName, "", WsPopup, 0, 0, 1, 1,
                IntPtr.Zero, IntPtr.Zero, windowClass.hInstance, IntPtr.Zero);
            if (window == IntPtr.Zero)
            {
                Log("tray badge window failed: " + Marshal.GetLastWin32Error());
                return;
            }
            _overlayWindow = window;
            Log("tray badge thread ready");
            // An arm that arrived while this thread was starting has no window
            // to post to yet; pick it up now.
            if (_overlayRequested) PostMessage(window, WmAppArm, IntPtr.Zero, IntPtr.Zero);
            MSG message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
            KillTimer(window, BlinkTimerId);
            KillTimer(window, ExpiryTimerId);
            DestroyWindow(window);
            _overlayWindow = IntPtr.Zero;
        }
        catch (Exception error)
        {
            Log("tray badge failed: " + error.Message);
        }
        finally
        {
            ReleaseDotContent();
            lock (OverlayLock) _overlayThread = null;
            Log("tray badge thread exit");
        }
    }

    static IntPtr OverlayWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            switch (msg)
            {
                case WmAppArm:
                    ArmBlink(hWnd);
                    return IntPtr.Zero;
                case WmAppStop:
                    HideDot(hWnd);
                    Log("tray badge cleared");
                    return IntPtr.Zero;
                case (uint)WmTimer:
                    if (wParam == new IntPtr(BlinkTimerId)) OnBlinkTick(hWnd);
                    else if (wParam == new IntPtr(ExpiryTimerId))
                    {
                        Log("tray badge stopped: timed out");
                        lock (OverlayLock) _overlayRequested = false;
                        HideDot(hWnd);
                    }
                    return IntPtr.Zero;
                case WmDisplayChange:
                case WmSettingChange:
                    // Taskbar moved/resized or the display changed: one cheap
                    // re-read is enough to keep the dot on the icon.
                    if (_overlayRequested) ShowDot(hWnd);
                    return IntPtr.Zero;
                case WmDestroy:
                    KillTimer(hWnd, BlinkTimerId);
                    KillTimer(hWnd, ExpiryTimerId);
                    return IntPtr.Zero;
            }
        }
        catch (Exception error)
        {
            Log("tray badge message failed: " + error.Message);
        }
        return DefWindowProc(hWnd, msg, wParam, lParam);
    }

    /// <summary>Start the blink and expiry timers for the current arm.</summary>
    static void ArmBlink(IntPtr window)
    {
        KillTimer(window, BlinkTimerId);
        KillTimer(window, ExpiryTimerId);
        SetTimer(window, BlinkTimerId, (uint)Math.Clamp(_blinkIntervalMs, 200, 5000), IntPtr.Zero);
        var limit = _blinkMaxMinutes;
        if (limit > 0)
        {
            var elapsed = Environment.TickCount64 - _overlayStartedAt;
            var remaining = Math.Max(1000L, limit * 60_000L - elapsed);
            SetTimer(window, ExpiryTimerId, (uint)Math.Min(remaining, int.MaxValue), IntPtr.Zero);
        }
        _overlayOn = false;
        OnBlinkTick(window);
    }

    static void OnBlinkTick(IntPtr window)
    {
        bool requested;
        lock (OverlayLock) requested = _overlayRequested;
        if (!requested)
        {
            HideDot(window);
            return;
        }
        if (!_overlayIgnoreFocus && TestDshWindowFocused())
        {
            Log("tray badge stopped: DSH is foreground");
            lock (OverlayLock) _overlayRequested = false;
            HideDot(window);
            return;
        }
        _overlayOn = !_overlayOn;
        if (!_overlayOn)
        {
            ShowWindow(window, SwHide);
            return;
        }
        ShowDot(window);
    }

    /// <summary>Position the dot on the icon and show it; false when the cell is gone.</summary>
    static bool ShowDot(IntPtr window)
    {
        if (!TryQueryTrayRect(out var cell))
        {
            HideDot(window);
            // Two misses in a row means the icon was filed into the Windows 11
            // overflow flyout (or Explorer restarted): retarget the reminder to
            // the taskbar button instead of silently dropping it.
            if (++_trayMisses >= 2)
            {
                _trayMisses = 0;
                Log("tray badge lost the icon; falling back to the taskbar badge");
                lock (OverlayLock) _overlayRequested = false;
                StartTaskbarBadge(_overlayReason, _blinkIntervalMs, _blinkMaxMinutes);
            }
            return false;
        }
        _trayMisses = 0;

        // The tray cell spans the taskbar height; Windows 11 draws the icon at
        // half the cell width, centred.
        var cellWidth = cell.Right - cell.Left;
        var iconSize = Math.Max(16, (int)Math.Round(cellWidth * 0.5));
        var iconLeft = cell.Left + (cellWidth - iconSize) / 2;
        var iconTop = (cell.Top + cell.Bottom) / 2 - iconSize / 2;
        var dot = Math.Clamp((int)Math.Round(iconSize * 0.62), 10, 28);
        var x = iconLeft + iconSize - (int)Math.Round(dot * 0.62);
        var y = iconTop + iconSize - (int)Math.Round(dot * 0.62);

        if (dot != _dotSize)
        {
            if (!SetDotContent(dot))
            {
                Log("tray badge content failed");
                return false;
            }
        }
        if (x != _dotX || y != _dotY)
        {
            _dotX = x;
            _dotY = y;
            ApplyDotPosition(x, y, dot);
        }
        SetWindowPos(window, HwndTopmost, x, y, dot, dot, SwpNoactivate);
        ShowWindow(window, SwShowNoActivate);
        return true;
    }

    static void HideDot(IntPtr window)
    {
        _overlayOn = false;
        if (window != IntPtr.Zero) ShowWindow(window, SwHide);
    }

    static void ApplyDotPosition(int x, int y, int size)
    {
        if (_overlayWindow == IntPtr.Zero || _dibDc == IntPtr.Zero) return;
        var destination = new POINT { x = x, y = y };
        var source = new POINT { x = 0, y = 0 };
        var dimensions = new SIZE { cx = size, cy = size };
        var blend = new BLENDFUNCTION
        {
            BlendOp = 0, // AC_SRC_OVER
            BlendFlags = 0,
            SourceConstantAlpha = 255,
            AlphaFormat = (byte)AcSrcAlpha,
        };
        UpdateLayeredWindow(_overlayWindow, IntPtr.Zero, ref destination, ref dimensions,
            _dibDc, ref source, 0, ref blend, UlwAlpha);
    }

    /// <summary>Render the dot into a premultiplied 32bpp DIB for UpdateLayeredWindow.</summary>
    static bool SetDotContent(int size)
    {
        try
        {
            ReleaseDotContent();
            var header = new BITMAPINFOHEADER
            {
                biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
                biWidth = size,
                biHeight = -size, // top-down, matching Bitmap's scan order
                biPlanes = 1,
                biBitCount = 32,
                biCompression = BiRgb,
            };
            _dibDc = CreateCompatibleDC(IntPtr.Zero);
            _dib = CreateDIBSection(_dibDc, ref header, DibRgbColors, out _dibBits, IntPtr.Zero, 0);
            if (_dib == IntPtr.Zero)
            {
                Log("tray badge DIB failed: " + Marshal.GetLastWin32Error());
                return false;
            }
            _dibPrevious = SelectObject(_dibDc, _dib);

            using var bitmap = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                using var ring = new SolidBrush(Color.White);
                using var red = new SolidBrush(Color.FromArgb(235, 64, 52));
                var edge = size * 0.04f;
                graphics.FillEllipse(ring, edge, edge, size - 2 * edge, size - 2 * edge);
                graphics.FillEllipse(red, size * 0.18f, size * 0.18f, size * 0.64f, size * 0.64f);
            }
            var data = bitmap.LockBits(new Rectangle(0, 0, size, size),
                System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
            try
            {
                var row = new byte[size * 4];
                for (var y = 0; y < size; y++)
                {
                    Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                    Marshal.Copy(row, 0, IntPtr.Add(_dibBits, y * size * 4), row.Length);
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
            _dotSize = size;
            _dotX = int.MinValue;
            _dotY = int.MinValue;
            return true;
        }
        catch (Exception error)
        {
            Log("tray badge content failed: " + error.Message);
            return false;
        }
    }

    static void ReleaseDotContent()
    {
        try
        {
            if (_dibDc != IntPtr.Zero && _dibPrevious != IntPtr.Zero) SelectObject(_dibDc, _dibPrevious);
            if (_dib != IntPtr.Zero) DeleteObject(_dib);
            if (_dibDc != IntPtr.Zero) DeleteDC(_dibDc);
        }
        catch { }
        _dib = IntPtr.Zero;
        _dibDc = IntPtr.Zero;
        _dibPrevious = IntPtr.Zero;
        _dibBits = IntPtr.Zero;
        _dotSize = 0;
    }

    /// <summary>
    /// Screen rectangle of DSH's own tray icon. Electron hosts its icons on an
    /// `Electron_NotifyIconHostWindow`; the window/id pair is resolved once and
    /// then reused, so the steady-state cost is one `Shell_NotifyIconGetRect`
    /// call per blink.
    /// </summary>
    static bool TryQueryTrayRect(out RECT rect)
    {
        rect = default;
        try
        {
            for (var attempt = 0; attempt < 2; attempt++)
            {
                if (_trayHost == IntPtr.Zero || !IsWindow(_trayHost))
                {
                    if (!ResolveTrayHost()) return false;
                }
                var identifier = new NOTIFYICONIDENTIFIER
                {
                    cbSize = Marshal.SizeOf<NOTIFYICONIDENTIFIER>(),
                    hWnd = _trayHost,
                    uID = _trayUid,
                };
                if (Shell_NotifyIconGetRect(ref identifier, out var cell) == 0 && cell.Right > cell.Left)
                {
                    rect = cell;
                    return true;
                }
                // The window/id went stale (Electron rebuilt its tray): resolve
                // once more before giving up for this frame.
                _trayHost = IntPtr.Zero;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Find Electron's tray host window and the id the shell accepts.</summary>
    static bool ResolveTrayHost()
    {
        var main = FindDshWindow(includeHidden: true);
        if (main == IntPtr.Zero) return false;
        GetWindowThreadProcessId(main, out var processId);
        var host = IntPtr.Zero;
        uint id = 0;
        EnumWindows((h, _) =>
        {
            GetWindowThreadProcessId(h, out var owner);
            if (owner != processId) return true;
            var name = new StringBuilder(256);
            GetClassName(h, name, name.Capacity);
            if (!name.ToString().StartsWith("Electron_NotifyIconHostWindow", StringComparison.Ordinal)) return true;
            for (uint candidate = 1; candidate <= 16; candidate++)
            {
                var identifier = new NOTIFYICONIDENTIFIER
                {
                    cbSize = Marshal.SizeOf<NOTIFYICONIDENTIFIER>(),
                    hWnd = h,
                    uID = candidate,
                };
                if (Shell_NotifyIconGetRect(ref identifier, out var cell) != 0) continue;
                if (cell.Right - cell.Left <= 0) continue;
                host = h;
                id = candidate;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (host == IntPtr.Zero) return false;
        _trayHost = host;
        _trayUid = id;
        return true;
    }
}
