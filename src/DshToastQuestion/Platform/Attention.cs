namespace DshToastQuestion;

static partial class Program
{
    // ---------------------------------------------------------------------
    // Attention effects. The host decides, per event, whether a notification
    // is a toast, a taskbar badge blink, a taskbar flash, or any combination of
    // them. This is the single place the helper arms/retires them, so every
    // toast path (question, approval, done, receipt, effect-only) behaves the
    // same.
    // ---------------------------------------------------------------------

    /// <summary>
    /// Start the attention effects attached to one event. Does nothing when
    /// DSH is already in front: there is nothing to attract the user to.
    /// </summary>
    /// <param name="effects">Host policy; null means "no effects".</param>
    /// <param name="reason">Event key or human label, used for the badge tooltip.</param>
    static void StartAttention(EffectPolicy? effects, string reason)
    {
        if (effects == null)
        {
            Log("attention skipped: no effects");
            return;
        }
        if (!effects.Blink && !effects.Flash)
        {
            Log("attention skipped: no effect enabled (" + reason + ")");
            return;
        }
        try
        {
            var focused = TestDshWindowFocused();
            Log("attention: blink=" + effects.Blink + " flash=" + effects.Flash +
                " timing=" + (effects.Timing ?? "") + " focused=" + focused + " (" + reason + ")");
            if (focused) return;
            if (effects.Blink) StartTaskbarBadge(reason, _blinkIntervalMs, _blinkMaxMinutes);
            if (effects.Flash) FlashTaskbar();
        }
        catch (Exception error)
        {
            // Attention must never break the toast flow.
            Log("attention failed: " + error.Message);
        }
    }

    /// <summary>Retire every attention effect (answered, resolved, focused, teardown).</summary>
    static void StopAttention()
    {
        StopTaskbarFlash();
        StopTaskbarBadge();
    }

    /// <summary>Retire every effect and wait for the owned badge to be cleared.</summary>
    static void DisposeAttention()
    {
        StopTaskbarFlash();
        DisposeTaskbarBadge();
    }
}
