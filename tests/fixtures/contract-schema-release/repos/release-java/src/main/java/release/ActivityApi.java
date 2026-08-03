package release;

import org.apache.dubbo.config.annotation.DubboService;

interface ParentApi<T> { T load(T value); }

@DubboService
interface ActivityApi extends ParentApi<ActivityView> {
  ActivityView find(ActivityInput input);
  ActivityView find(ActivityInput input, int page);
}
