namespace DshToastQuestion;

/// <summary>
/// CLSID of the shell taskbar object that implements `ITaskbarList3`. Created
/// through `Activator` because a `[ComImport]` coclass cannot be cast to its
/// interface by the C# compiler.
/// </summary>
static class TaskbarList
{
    internal static readonly Guid Clsid = new("56FDF344-FD6D-11d0-958A-006097C9A090");
}

/// <summary>Overlay-icon slice of `ITaskbarList3` (Windows 7+).</summary>
[ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ITaskbarList3
{
    // ITaskbarList
    void HrInit();
    void AddTab(IntPtr hwnd);
    void DeleteTab(IntPtr hwnd);
    void ActivateTab(IntPtr hwnd);
    void SetActiveAlt(IntPtr hwnd);

    // ITaskbarList2
    void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);

    // ITaskbarList3
    void SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
    void SetProgressState(IntPtr hwnd, int state);
    void RegisterTab(IntPtr hwndTab, IntPtr hwndMdi);
    void UnregisterTab(IntPtr hwndTab);
    void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
    void SetTabActive(IntPtr hwndTab, IntPtr hwndInsertBefore, uint reserved);
    void ThumbBarAddButtons(IntPtr hwnd, uint count, IntPtr buttons);
    void ThumbBarUpdateButtons(IntPtr hwnd, uint count, IntPtr buttons);
    void ThumbBarSetImageList(IntPtr hwnd, IntPtr imageList);

    /// <summary>
    /// Draw (or clear, with a null icon) the small badge on the window's
    /// taskbar button. The shell copies the image, so the caller keeps
    /// ownership of `icon`.
    /// </summary>
    void SetOverlayIcon(IntPtr hwnd, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string description);

    void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string tip);
    void SetThumbnailClip(IntPtr hwnd, IntPtr clip);
}
