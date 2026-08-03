package release;

class BaseRecord { String id; }
class ActivityInput extends BaseRecord { String query; }
class ActivityView extends BaseRecord { String activityId; String displayName; }
class PageEnvelope<T> { java.util.List<T> items; int total; }
class TransportEnvelope<T> { T data; }
class Headers {}
class MissingPayload {}
class DeepRoot { Deep1 value; }
class Deep1 { Deep2 value; }
class Deep2 { Deep3 value; }
class Deep3 { Deep4 value; }
class Deep4 { Deep5 value; }
class Deep5 { Deep6 value; }
class Deep6 { Deep7 value; }
class Deep7 { Deep8 value; }
class Deep8 { Deep9 value; }
class Deep9 { Deep10 value; }
class Deep10 { Deep11 value; }
class Deep11 { Deep12 value; }
class Deep12 { Deep13 value; }
class Deep13 { Deep14 value; }
class Deep14 { String value; }
