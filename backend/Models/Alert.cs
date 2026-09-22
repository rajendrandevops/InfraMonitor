namespace InfraMonitor.Api.Models;

public class Alert
{
    public int Id { get; set; }

    public int DeviceId { get; set; }

    public string EventType { get; set; } = string.Empty;

    public string Message { get; set; } = string.Empty;

    public bool IsAcknowledged { get; set; }

    public DateTime CreatedAt { get; set; }

    public Device? Device { get; set; }
}