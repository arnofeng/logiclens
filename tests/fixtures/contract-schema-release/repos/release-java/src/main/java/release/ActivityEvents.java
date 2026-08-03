package release;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.kafka.annotation.KafkaListener;
import reactor.core.publisher.Mono;

class ActivityEvents {
  ApplicationEventPublisher publisher;
  @EventListener void on(ActivityView value) {}
  void publish(ActivityView value) { publisher.publishEvent(value); }
  @KafkaListener(topics="release.ambiguous") void ambiguous(ActivityInput left, ActivityView right) {}
  @KafkaListener(topics="release.external") void external(java.io.File value) {}
  @KafkaListener(topics="release.unsupported") void unsupported(Mono<ActivityView> value) {}
  @KafkaListener(topics="release.unresolved") void unresolved(UnknownPayload value) {}
  @KafkaListener(topics="release.truncated") void truncated(DeepRoot value) {}
}
