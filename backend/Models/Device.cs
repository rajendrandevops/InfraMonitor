namespace InfraMonitor.Api.Models;

public class Device
{
    public int Id { get; set; }

    public string Name { get; set; } = string.Empty;

    public string IpAddress { get; set; } = string.Empty;

    public int GroupId { get; set; }

    public int PingIntervalSeconds { get; set; } = 5;

    public bool Enabled { get; set; } = true;

    public bool IsUp { get; set; }

    public long? LastLatencyMs { get; set; }

    public DateTime? LastChecked { get; set; }

    public DateTime? LastSeen { get; set; }

    public string? LastError { get; set; }

    public DateTime? NextCheckAt { get; set; }

    public DeviceGroup? Group { get; set; }

    public ICollection<PingResult> PingResults { get; set; }
        = new List<PingResult>();
}