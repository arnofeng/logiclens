using System.ComponentModel.DataAnnotations;
using System.Runtime.Serialization;
using System.Text.Json.Serialization;

namespace Contracts;

public record CreateOrderRequest(
  [property: JsonPropertyName("customer_id")] string CustomerId,
  int? Quantity = null,
  [property: Required] List<string> Tags
);

public record OrderResponse {
  [JsonRequired]
  public required Guid Id { get; init; }

  public string? Note { get; init; }

  public decimal Total { get; init; } = 0m;

  [JsonIgnore]
  public string? Secret { get; init; }
}

[DataContract]
public struct AddressContract {
  [DataMember(Name = "postal_code", IsRequired = true)]
  public string PostalCode { get; set; }

  [JsonInclude]
  public Dictionary<string, int?> Counts;

  public string NotSerialized;
}

public class ExplicitlyReferenced {
  public int[] Values { get; set; }
  public IReadOnlyList<AddressContract?>? Addresses { get; set; }
}

public class OrdinaryDomainEntity {
  public string Id { get; set; } = "";
}

public class PayloadModel {
  public Nested.Value<string?> Item { get; set; } = default!;
}
