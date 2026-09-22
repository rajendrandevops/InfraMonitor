namespace InfraMonitor.Api.Models;

public class MonitorSetting
{
    public int Id { get; set; }

    public int DefaultPingIntervalSeconds { get; set; } = 5;

    public int PingTimeoutMilliseconds { get; set; } = 2000;

    public int HistoryRetentionHours { get; set; } = 72;

    public bool MonitoringEnabled { get; set; } = true;
}