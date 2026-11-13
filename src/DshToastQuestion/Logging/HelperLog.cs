namespace DshToastQuestion;

static partial class Program
{
    static readonly object LogLock = new();

    static void Log(string message)
    {
        if (string.IsNullOrEmpty(_logPath)) return;
        // Several threads log (badge tickers, foreground hook, main loop); an
        // unserialized append throws for the loser and silently loses the line.
        lock (LogLock)
        {
            try
            {
                File.AppendAllText(_logPath!, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
            }
            catch { }
        }
    }
}
