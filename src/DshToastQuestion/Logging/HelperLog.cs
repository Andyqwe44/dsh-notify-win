namespace DshToastQuestion;

static partial class Program
{
    static void Log(string message)
    {
        if (string.IsNullOrEmpty(_logPath)) return;
        try
        {
            File.AppendAllText(_logPath!, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
        }
        catch { }
    }
}
