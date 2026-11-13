namespace DshToastQuestion;

/// <summary>
/// QQ-style tray reminder.
///
/// The DSH tray icon belongs to the Electron main process and cannot be
/// animated from another process, so this helper registers a small
/// "notification" icon of its own and toggles it between two frames (the DSH
/// mark, and the same mark with a red unread dot). The icon lives on a
/// dedicated STA thread with a WinForms message loop, because NotifyIcon
/// requires one.
///
/// The icon is shown while DSH runs ("always") or only while it blinks
/// ("on-blink"), according to the host's `config` op. It stops blinking as soon
/// as a DSH window is foreground, when the user clicks it, when the toast is
/// answered/resolved, and when the helper shuts down.
/// </summary>
static partial class Program
{
    static readonly object BlinkLock = new();
    static volatile bool _blinkRequested;
    static volatile string _blinkReason = "";
    static long _blinkStartedAt;
    static long _blinkToggledAt;
    static bool _blinkFrameOn;
    static Thread? _blinkThread;
    static NotifyIcon? _blinkIcon;
    static Icon? _blinkFrameA;
    static Icon? _blinkFrameB;
    static bool _trayPromoted;

    /// <summary>Arm (or refresh) the tray blink; safe from any thread.</summary>
    static void StartTrayBlink(string reason, int intervalMs, int maxMinutes)
    {
        lock (BlinkLock)
        {
            _blinkIntervalMs = Math.Clamp(intervalMs, 200, 5000);
            _blinkMaxMinutes = Math.Max(0, maxMinutes);
            _blinkReason = string.IsNullOrEmpty(reason) ? "有新的通知" : reason;
            if (!_blinkRequested)
            {
                _blinkRequested = true;
                _blinkStartedAt = Environment.TickCount64;
                _blinkToggledAt = _blinkStartedAt;
                _blinkFrameOn = false;
            }
        }
        EnsureBlinkThread();
        // The same foreground hook that stops the taskbar flash also retires
        // the blink the moment a DSH window is activated.
        EnsureFlashWatcher();
        Log("tray blink armed: " + _blinkReason + " interval=" + _blinkIntervalMs + " max=" + _blinkMaxMinutes);
    }

    /// <summary>Stop blinking; the ticker applies it on the tray thread.</summary>
    static void StopTrayBlink()
    {
        lock (BlinkLock) _blinkRequested = false;
    }

    static bool TrayBlinking()
    {
        lock (BlinkLock) return _blinkRequested;
    }

    /// <summary>Start the tray thread once (idempotent, any thread).</summary>
    static void EnsureBlinkThread()
    {
        Thread? thread;
        lock (BlinkLock)
        {
            if (_blinkThread != null) return;
            thread = new Thread(BlinkThreadMain)
            {
                IsBackground = true,
                Name = "dsh-tray-blink",
            };
            thread.SetApartmentState(ApartmentState.STA);
            _blinkThread = thread;
        }
        thread.Start();
    }

    /// <summary>Owns the NotifyIcon and its message loop for the helper lifetime.</summary>
    static void BlinkThreadMain()
    {
        try
        {
            using var context = new ApplicationContext();
            _blinkFrameA = BuildBlinkIcon(false);
            _blinkFrameB = BuildBlinkIcon(true);
            using var icon = new NotifyIcon
            {
                Icon = _blinkFrameA,
                Text = "DeepSeek Harness",
                Visible = false,
            };
            _blinkIcon = icon;
            icon.MouseUp += (_, args) =>
            {
                if (args.Button != MouseButtons.Left) return;
                StopAttention();
                _ = Task.Run(FocusDsh);
            };
            using var menu = new ContextMenuStrip();
            menu.Items.Add("打开 DeepSeek Harness", null, (_, _) =>
            {
                StopAttention();
                _ = Task.Run(FocusDsh);
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("停止闪烁", null, (_, _) => StopAttention());
            icon.ContextMenuStrip = menu;

            using var timer = new System.Windows.Forms.Timer { Interval = 250 };
            timer.Tick += (_, _) => TickBlink();
            timer.Start();
            Log("tray blink thread ready");
            Application.Run(context);
            timer.Stop();
            icon.Visible = false;
            _blinkIcon = null;
        }
        catch (Exception error)
        {
            Log("tray blink failed: " + error.Message);
        }
        finally
        {
            _blinkThread = null;
            _blinkFrameA?.Dispose();
            _blinkFrameB?.Dispose();
            _blinkFrameA = null;
            _blinkFrameB = null;
        }
    }

    /// <summary>
    /// One 250ms tick on the tray thread: enforce the stop conditions, keep the
    /// icon visible according to the mode, and toggle the two frames.
    /// </summary>
    static void TickBlink()
    {
        var icon = _blinkIcon;
        if (icon == null) return;

        if (_blinkRequested)
        {
            var expired = _blinkMaxMinutes > 0 &&
                Environment.TickCount64 - _blinkStartedAt >= _blinkMaxMinutes * 60_000L;
            if (expired || TestDshWindowFocused())
            {
                lock (BlinkLock) _blinkRequested = false;
                if (expired) Log("tray blink stopped: timed out");
                else Log("tray blink stopped: DSH is foreground");
            }
        }

        var blinking = _blinkRequested;
        var visible = blinking || _trayIconMode == "always";
        if (icon.Visible != visible)
        {
            icon.Visible = visible;
            Log("tray icon visible=" + visible + " blinking=" + blinking);
        }
        if (!visible) return;
        // Pin the icon into the visible tray once (Win11 otherwise files a new
        // icon in the hidden flyout). Re-registering applies the setting.
        if (!_trayPromoted && PromoteTrayIcon())
        {
            icon.Visible = false;
            icon.Visible = true;
            Log("tray icon re-registered after promotion");
        }

        if (blinking)
        {
            var now = Environment.TickCount64;
            if (now - _blinkToggledAt >= _blinkIntervalMs)
            {
                _blinkToggledAt = now;
                _blinkFrameOn = !_blinkFrameOn;
                icon.Icon = _blinkFrameOn ? _blinkFrameB : _blinkFrameA;
            }
            icon.Text = Shorten("DeepSeek Harness · " + _blinkReason, 63);
        }
        else
        {
            icon.Icon = _blinkFrameA;
            icon.Text = "DeepSeek Harness";
        }
    }

    /// <summary>Apply one `config` op from the host.</summary>
    static void ApplyBlinkConfig(InboundMessage message)
    {
        _trayIconMode = string.Equals(message.TrayIcon, "on-blink", StringComparison.OrdinalIgnoreCase)
            ? "on-blink"
            : "always";
        if (message.BlinkIntervalMs is int interval)
        {
            _blinkIntervalMs = Math.Clamp(interval, 200, 5000);
        }
        if (message.BlinkMaxMinutes is int minutes)
        {
            _blinkMaxMinutes = Math.Max(0, minutes);
        }
        EnsureBlinkThread();
        Log("attention config: icon=" + _trayIconMode + " interval=" + _blinkIntervalMs +
            " maxMinutes=" + _blinkMaxMinutes);
    }

    /// <summary>
    /// Pin the notification icon into the visible tray. Windows 11 files a new
    /// tray icon into the hidden-flyout by default; the shell reads this
    /// per-icon setting when the icon is registered, so the helper sets it once
    /// and re-registers the icon.
    /// </summary>
    static bool PromoteTrayIcon()
    {
        if (_trayPromoted) return true;
        try
        {
            // Promote once per machine profile: if the user later unpins the
            // icon, the helper must not fight that decision on every start.
            using var marker = Registry.CurrentUser.CreateSubKey(@"Software\dsh-notify-win");
            if (marker?.GetValue("TrayPromoted") is int already && already == 1)
            {
                _trayPromoted = true;
                return true;
            }
            string exe = Environment.ProcessPath ?? "";
            using var root = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings", true);
            if (root == null) return false;
            foreach (string name in root.GetSubKeyNames())
            {
                using var sub = root.OpenSubKey(name, true);
                if (sub == null) continue;
                string path = sub.GetValue("ExecutablePath") as string ?? "";
                if (!string.Equals(path, exe, StringComparison.OrdinalIgnoreCase)) continue;
                if (!(sub.GetValue("IsPromoted") is int promoted) || promoted != 1)
                {
                    sub.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                    Log("tray icon promoted");
                }
                marker?.SetValue("TrayPromoted", 1, RegistryValueKind.DWord);
                _trayPromoted = true;
                return true;
            }
        }
        catch (Exception error)
        {
            Log("tray promote failed: " + error.Message);
        }
        return false;
    }

    /// <summary>Draw one 32x32 tray frame: the DSH mark, optionally badged.</summary>
    static Icon BuildBlinkIcon(bool alert)
    {
        try
        {
            using var bitmap = new Bitmap(32, 32);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                Icon? mark = null;
                try
                {
                    var path = Path.Combine(AppContext.BaseDirectory, "dsh-logo.ico");
                    if (File.Exists(path)) mark = new Icon(path);
                    if (mark != null) graphics.DrawIcon(mark, new Rectangle(0, 0, 32, 32));
                    else
                    {
                        using var blue = new SolidBrush(Color.FromArgb(37, 99, 235));
                        graphics.FillEllipse(blue, 3, 3, 26, 26);
                        using var font = new Font("Segoe UI", 14, FontStyle.Bold, GraphicsUnit.Pixel);
                        using var white = new SolidBrush(Color.White);
                        graphics.DrawString("D", font, white, new PointF(9, 7));
                    }
                }
                finally
                {
                    mark?.Dispose();
                }
                if (alert)
                {
                    // The unread dot: a white ring keeps it readable on any
                    // wallpaper/tray background.
                    using var ring = new SolidBrush(Color.White);
                    using var red = new SolidBrush(Color.FromArgb(235, 64, 52));
                    graphics.FillEllipse(ring, 18, 18, 14, 14);
                    graphics.FillEllipse(red, 20, 20, 10, 10);
                }
            }
            IntPtr handle = bitmap.GetHicon();
            try
            {
                using var temporary = Icon.FromHandle(handle);
                return (Icon)temporary.Clone();
            }
            finally
            {
                DestroyIcon(handle);
            }
        }
        catch (Exception error)
        {
            Log("tray icon build failed: " + error.Message);
            return SystemIcons.Application;
        }
    }
}
