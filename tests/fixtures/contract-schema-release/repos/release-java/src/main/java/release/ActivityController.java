package release;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
class ActivityController {
  @PostMapping("/activities")
  TransportEnvelope<PageEnvelope<ActivityView>> create(@RequestBody ActivityInput request) { return null; }
}
