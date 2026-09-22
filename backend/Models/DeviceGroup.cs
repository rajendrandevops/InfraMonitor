namespace InfraMonitor.Api.Models;

public class DeviceGroup
{
    public int Id { get; set; }

    public string Name { get; set; } = string.Empty;

    public string? Description { get; set; }

    public ICollection<Device> Devices { get; set; } = new List<Device>();
}