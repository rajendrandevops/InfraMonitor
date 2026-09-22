using InfraMonitor.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace InfraMonitor.Api.Data;

public class InfraMonitorDbContext : DbContext
{
    public InfraMonitorDbContext(
        DbContextOptions<InfraMonitorDbContext> options)
        : base(options)
    {
    }

    public DbSet<Device> Devices => Set<Device>();

    public DbSet<DeviceGroup> DeviceGroups => Set<DeviceGroup>();

    public DbSet<PingResult> PingResults => Set<PingResult>();

    public DbSet<Alert> Alerts => Set<Alert>();

    public DbSet<MonitorSetting> MonitorSettings => Set<MonitorSetting>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<DeviceGroup>()
            .HasMany(g => g.Devices)
            .WithOne(d => d.Group)
            .HasForeignKey(d => d.GroupId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<Device>()
            .HasIndex(d => d.IpAddress);

        modelBuilder.Entity<PingResult>()
            .HasOne(p => p.Device)
            .WithMany(d => d.PingResults)
            .HasForeignKey(p => p.DeviceId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<PingResult>()
            .HasIndex(p => new
            {
                p.DeviceId,
                p.CheckedAt
            });

        modelBuilder.Entity<Alert>()
            .HasOne(a => a.Device)
            .WithMany()
            .HasForeignKey(a => a.DeviceId)
            .OnDelete(DeleteBehavior.Cascade);

        modelBuilder.Entity<Alert>()
            .HasIndex(a => new
            {
                a.DeviceId,
                a.CreatedAt
            });

        modelBuilder.Entity<MonitorSetting>()
            .HasData(new MonitorSetting
            {
                Id = 1,
                DefaultPingIntervalSeconds = 5,
                PingTimeoutMilliseconds = 2000,
                HistoryRetentionHours = 72,
                MonitoringEnabled = true
            });
    }
}