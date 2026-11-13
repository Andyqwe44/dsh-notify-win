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
/// When the icon sits in the Windows 11 overflow flyout the shell reports no
/// rectangle; the caller then falls back to the taskbar-button badge.
/// </summary>
static partial class Program
{
    const int OverlayTickMs = 100;
    const int RectRefreshMs = 300;
    const int FallbackAfterMisses = 4;
    const string OverlayClassName = "DshTrayBadgeOverlay";

    static readonly object OverlayLock = new();
    static volatile bool _overlayRequested;
    static volatile bool _overlayIgnoreFocus;
    static string _overlayReason = "";
    static long _overlayStartedAt;
    static long _overlayToggledAt;
    static bool _overlayOn;
    static long _rectCheckedAt;
    static bool _rectValid;
    static RECT _rectCell;
    static int _overlayMisses;
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

    /// <summary>Arm the tray badge; false when DSH's tray icon cannot be located.</summary>
    static bool StartTrayBadge(string reason, int intervalMs, int maxMinutes)
    {
        if (!TryGetDshTrayIconRect(out _))
        {
            Log("tray badge unavailable: DSH tray icon is not in the visible notification area");
            return false;
        }
        lock (OverlayLock)
        {
            _blinkIntervalMs = Math.Clamp(intervalMs, 200, 5000);
            _blinkMaxMinutes = Math.Max(0, maxMinutes);
            _overlayReason = string.IsNullOrEmpty(reason) ? "有新的通知" : reason;
            if (!_overlayRequested)
            {
                _overlayRequested = true;
                _overlayStartedAt = Environment.TickCount64;
                _overlayToggledAt = _overlayStartedAt;
                _overlayOn = false;
            }
        }
        EnsureOverlayThread();
        // The same foreground hook that stops the taskbar flash retires the dot
        // the moment a DSH window is activated.
        EnsureFlashWatcher();
        Log("tray badge armed: " + _overlayReason + " interval=" + _blinkIntervalMs + " max=" + _blinkMaxMinutes);
        return true;
    }

    /// <summary>Stop blinking; the overlay thread hides the dot on its next tick.</summary>
    static void StopTrayBadge()
    {
        lock (OverlayLock) _overlayRequested = false;
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

    /// <summary>Owns the layered window and its 100 ms tick for the helper lifetime.</summary>
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
            SetTimer(window, TimerId, OverlayTickMs, IntPtr.Zero);
            Log("tray badge thread ready");
            MSG message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
            KillTimer(window, TimerId);
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
        if (msg == WmTimer)
        {
            try { OverlayTick(); }
            catch (Exception error) { Log("tray badge tick failed: " + error.Message); }
            return IntPtr.Zero;
        }
        return DefWindowProc(hWnd, msg, wParam, lParam);
    }

    static void OverlayTick()
    {
        var window = _overlayWindow;
        if (window == IntPtr.Zero) return;
        bool requested;
        long startedAt;
        lock (OverlayLock)
        {
            requested = _overlayRequested;
            startedAt = _overlayStartedAt;
        }
        if (requested && !_overlayIgnoreFocus)
        {
            var expired = _blinkMaxMinutes > 0 &&
                Environment.TickCount64 - startedAt >= _blinkMaxMinutes * 60_000L;
            if (expired || TestDshWindowFocused())
            {
                lock (OverlayLock) _overlayRequested = false;
                requested = false;
                Log(expired ? "tray badge stopped: timed out" : "tray badge stopped: DSH is foreground");
            }
        }
        if (!requested)
        {
            if (_overlayOn)
            {
                ShowWindow(window, SwHide);
                _overlayOn = false;
                Log("tray badge cleared");
            }
            return;
        }
        var now = Environment.TickCount64;
        if (now - _rectCheckedAt >= RectRefreshMs)
        {
            _rectCheckedAt = now;
            _rectValid = TryGetDshTrayIconRect(out var fresh);
            if (_rectValid) _rectCell = fresh;
        }
        if (!_rectValid)
        {
            if (_overlayOn)
            {
                ShowWindow(window, SwHide);
                _overlayOn = false;
            }
            // The icon was moved into the Windows 11 overflow flyout while the
            // dot was up; the cell is gone for good, so retarget the reminder
            // to the taskbar button instead of silently dropping it.
            if (++_overlayMisses >= FallbackAfterMisses)
            {
                _overlayMisses = 0;
                lock (OverlayLock) _overlayRequested = false;
                Log("tray badge lost the icon; falling back to the taskbar badge");
                StartTaskbarBadge(_overlayReason, _blinkIntervalMs, _blinkMaxMinutes);
            }
            return;
        }
        _overlayMisses = 0;
        var cell = _rectCell;

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
                return;
            }
        }
        if (x != _dotX || y != _dotY)
        {
            _dotX = x;
            _dotY = y;
            ApplyDotPosition(x, y, dot);
        }

        if (now - _overlayToggledAt >= _blinkIntervalMs)
        {
            _overlayToggledAt = now;
            _overlayOn = !_overlayOn;
            if (_overlayOn)
            {
                SetWindowPos(window, HwndTopmost, x, y, dot, dot, SwpNoactivate);
                ShowWindow(window, SwShowNoActivate);
            }
            else
            {
                ShowWindow(window, SwHide);
            }
        }
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
    /// `Electron_NotifyIconHostWindow`; the icon id is not public, so the ids
    /// the shell accepts for that window are probed (one hit wins).
    /// </summary>
    static bool TryGetDshTrayIconRect(out RECT cell)
    {
        cell = default;
        try
        {
            var main = FindDshWindow(includeHidden: true);
            if (main == IntPtr.Zero) return false;
            GetWindowThreadProcessId(main, out var processId);
            var result = new RECT();
            var found = false;
            EnumWindows((h, _) =>
            {
                GetWindowThreadProcessId(h, out var owner);
                if (owner != processId) return true;
                var name = new StringBuilder(256);
                GetClassName(h, name, name.Capacity);
                if (!name.ToString().StartsWith("Electron_NotifyIconHostWindow", StringComparison.Ordinal)) return true;
                for (uint id = 1; id <= 16; id++)
                {
                    var identifier = new NOTIFYICONIDENTIFIER
                    {
                        cbSize = Marshal.SizeOf<NOTIFYICONIDENTIFIER>(),
                        hWnd = h,
                        uID = id,
                    };
                    if (Shell_NotifyIconGetRect(ref identifier, out var rect) != 0) continue;
                    if (rect.Right - rect.Left <= 0) continue;
                    result = rect;
                    found = true;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            if (!found) return false;
            cell = result;
            return true;
        }
        catch
        {
            return false;
        }
    }
}
