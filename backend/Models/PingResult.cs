namespace InfraMonitor.Api.Models;

public class PingResult
{
    public int Id { get; set; }

    public int DeviceId { get; set; }

    public bool IsUp { get; set; }

    public long? LatencyMs { get; set; }

    public DateTime CheckedAt { get; set; }

    public string? ErrorMessage { get; set; }

    public Device? Device { get; set; }
}