namespace DshToastQuestion;

static partial class Program
{
    // ---------------------------------------------------------------------
    // Non-interactive notifications (done / compact / alert / notice /
    // approval). They are shown by this process so Activated and Dismissed are
    // available: the flash starts only after Windows times the toast out, and
    // clicking the toast focuses DSH. The toast's own `launch` argument also
    // covers the cold path where Windows starts this exe just for the click.
    // ---------------------------------------------------------------------
    static void ShowNotification(InboundMessage message)
    {
        if (TestDshWindowFocused())
        {
            Log("notify skipped: DSH is focused");
            return;
        }

        string title = message.Title ?? "";
        string body = message.Body ?? "";
        string duration = string.Equals(message.Duration, "long", StringComparison.OrdinalIgnoreCase) ? "long" : "short";
        string launch = string.IsNullOrEmpty(message.Launch) ? "--focus" : message.Launch!;

        var sb = new StringBuilder();
        // The toast schema has no activationType attribute; `launch` is passed
        // to this app on a normal (foreground) activation, which is exactly what
        // `--focus` needs. A cold click starts this exe with that argument.
        sb.Append("<toast launch=\"").Append(XmlEscape(launch))
          .Append("\" duration=\"").Append(duration)
          .Append("\"><visual><binding template=\"ToastGeneric\">");
        sb.Append("<text>").Append(XmlEscape(title)).Append("</text>");
        sb.Append("<text>").Append(XmlEscape(body)).Append("</text>");
        sb.Append("</binding></visual></toast>");

        try
        {
            var doc = new XmlDocument();
            doc.LoadXml(sb.ToString());
            string tag = "dsh-n-" + Interlocked.Increment(ref _notifyTagSeq).ToString();
            var toast = new ToastNotification(doc)
            {
                Tag = tag,
                Group = NotifyGroup,
            };
            Track(tag);
            toast.Activated += (sender, eventArgs) =>
            {
                StopTaskbarFlash();
                FocusDsh();
            };
            toast.Dismissed += (sender, eventArgs) =>
            {
                if (eventArgs.Reason == ToastDismissalReason.TimedOut) FlashTaskbar();
            };
            if (!ShowToast(toast))
            {
                Log("notify toast failed; falling back to balloon");
                ShowBalloon(title, body);
            }
            Log("notify: kind=" + (message.Kind ?? "") + " tag=" + tag +
                " reason=" + (message.Reason ?? "") + " code=" + (message.Code ?? ""));
        }
        catch (Exception error)
        {
            Log("notify failed: " + error.Message);
            ShowBalloon(title, body);
        }
    }

    /// <summary>
    /// Show a toast with the branded identity, falling back to the PowerShell
    /// identity only if the branded notifier cannot be created. There is no
    /// script host anywhere in the notification path.
    /// </summary>
    static bool ShowToast(ToastNotification toast)
    {
        foreach (string appId in ToastIdentities)
        {
            try
            {
                ToastNotificationManager.CreateToastNotifier(appId).Show(toast);
                return true;
            }
            catch (Exception error)
            {
                Log("toast identity failed: " + appId + " (" + error.Message + ")");
            }
        }
        return false;
    }

    /// <summary>Last-resort balloon when even the toast could not be shown.</summary>
    static void ShowBalloon(string title, string body)
    {
        try
        {
            var icon = new NotifyIcon
            {
                Icon = SystemIcons.Information,
                Visible = true,
                BalloonTipTitle = title,
                BalloonTipText = body,
                BalloonTipIcon = ToolTipIcon.Info,
            };
            icon.ShowBalloonTip(8000);
            var previous = _balloon;
            _balloon = icon;
            previous?.Dispose();
            _ = Task.Delay(9000).ContinueWith(_ =>
            {
                try
                {
                    if (ReferenceEquals(_balloon, icon)) _balloon = null;
                    icon.Dispose();
                }
                catch { }
            });
        }
        catch (Exception error)
        {
            Log("balloon failed: " + error.Message);
        }
    }

    static void RemoveToast(string tag, string group)
    {
        try
        {
            ToastNotificationManager.History.Remove(tag, group, Aumid);
        }
        catch { }
        lock (LiveToasts) LiveToasts.Remove(tag);
    }

    static void Track(string tag)
    {
        lock (LiveToasts)
        {
            if (!LiveToasts.Add(tag)) return;
            TrackOrder.Enqueue(tag);
            // Only the newest toasts need shutdown cleanup; older ones have
            // already expired. This keeps both structures bounded.
            while (TrackOrder.Count > 32)
            {
                LiveToasts.Remove(TrackOrder.Dequeue());
            }
        }
    }

    static void CleanupToasts()
    {
        // The helper is going away: on a hot reload or DSH exit the shell must
        // not keep a flash armed for a toast nobody owns anymore.
        StopTaskbarFlash();
        string[] tags;
        lock (LiveToasts) tags = LiveToasts.ToArray();
        foreach (var tag in tags)
        {
            string group = tag.StartsWith("dsh-q-", StringComparison.Ordinal) ? QuestionGroup
                : tag.StartsWith("dsh-n-", StringComparison.Ordinal) ? NotifyGroup
                : AnswerGroup;
            RemoveToast(tag, group);
        }
        lock (LiveToasts) LiveToasts.Clear();
    }
}
